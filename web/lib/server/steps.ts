import { randomUUID } from 'node:crypto';
import { analyzePdf, sha256, type AnalysisResult } from '../../../src/pipeline.ts';
import { analyzeCode, validateCodeFiles, codeAssetId, type CodeFile } from '../../../src/coding.ts';
import { freshMetrics, BudgetError, SchemaValidationError, type CostBudget } from '../../../src/llm.ts';
import { openRouterSession, OPENROUTER_MODELS, OPENROUTER_REQUEST_INTERVAL_MS, RateLimitPause } from '../../../src/openrouter.ts';
import { nextModel, RESUME_VERSION, resumedMetrics, retryDelay, type Checkpoint } from '../../../src/resume.ts';
import { executionBudget, loadRuntimeEnv } from '../../../src/env.ts';
import { MAX_PDF_BYTES } from '../../../src/constants.ts';
import { assetPrefix, signedAsset, uploadAsset } from './assets.ts';
import { dbRequest, rpc, runPayload, type StoredRun } from './database.ts';
import { ROOT, AnswerError, stageOf, toClientResult, ownedStatus } from './runner.ts';
import { boundedBody, verifyUploadedPdf } from './upload.ts';
import type { ClientResult, SourceAsset } from '../types.ts';

function settings() {
  loadRuntimeEnv(ROOT);
  const budget = executionBudget(ROOT, process.env);
  const models = { model: process.env.OPENROUTER_MODEL || OPENROUTER_MODELS.vision,
    skimModel: process.env.OPENROUTER_SKIM_MODEL || OPENROUTER_MODELS.skim,
    reviewModel: process.env.OPENROUTER_REVIEW_MODEL || OPENROUTER_MODELS.vision,
    questionModel: process.env.OPENROUTER_QUESTION_MODEL || OPENROUTER_MODELS.questions };
  return { ...budget, models, version: `${RESUME_VERSION}:${process.env.VERCEL_GIT_COMMIT_SHA || 'local'}:${sha256(JSON.stringify(models)).slice(0,16)}` };
}

export async function requireStepBudget() {
  let config: ReturnType<typeof settings>;
  try { config = settings(); }
  catch { throw new AnswerError('새 AI 분석이 일시 중지되어 있어요. 운영 예산 설정을 확인해주세요. 예제 체험은 이용할 수 있어요.', 503); }
  let budget: { limit_usd: number; spent_usd: number; reserved_usd: number; blocked: boolean; legacy_sha256: string } | undefined;
  try { [budget] = await dbRequest('/rest/v1/proofolio_execution_budget?id=eq.true&select=limit_usd,spent_usd,reserved_usd,blocked,legacy_sha256'); }
  catch { throw new AnswerError('분석 예산 DB에 연결하지 못했어요. Supabase 연결과 SQL 005·006 적용을 확인해주세요.', 503); }
  if (budget?.blocked) throw new AnswerError('새 AI 분석이 일시 중지되어 있어요. 운영자가 예산을 다시 승인해야 해요. 예제 체험은 이용할 수 있어요.', 503);
  if (!budget || !budget.legacy_sha256 || Number(budget.limit_usd) !== config.limit ||
    Number(budget.spent_usd) + Number(budget.reserved_usd) >= config.limit)
    throw new AnswerError('승인된 운영 예산이 DB에 연결되지 않았거나 남은 예산이 부족해요.', 503);
  return config;
}

export async function initializeSteps(run: StoredRun) {
  const config = settings();
  if (run.storage !== 'supabase' || !run.userId) throw new AnswerError('단계 실행에는 Supabase 연결이 필요해요.', 503);
  try {
    await rpc('proofolio_init_analysis', { p_run_id: run.runId, p_user_id: run.userId, p_version: config.version, p_limit: config.limit });
  } catch (e) {
    throw new AnswerError(e instanceof Error && e.message.includes('(402)')
      ? '승인된 운영 예산이 DB에 연결되지 않았거나 남은 예산이 부족해요.'
      : '단계 실행 DB 설정을 확인해주세요. SQL 005 적용이 필요해요.', 503);
  }
  run.state = 'running'; run.execution = 'steps';
  return run;
}

async function inputBytes(run: StoredRun) {
  const path = assetPrefix(run.userId!, run.runId) + (run.track === 'coding' ? 'code.json' : 'portfolio.pdf');
  const response = await fetch(await signedAsset(run.userId!, run.runId, path), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('저장한 입력 파일을 읽지 못했어요.');
  const bytes = await boundedBody(response, run.track === 'coding' ? 200_000 : MAX_PDF_BYTES);
  if (run.track === 'coding') {
    if (sha256(bytes) !== run.pdfSha256) throw new Error('입력 해시가 변경됐어요.');
  } else verifyUploadedPdf(bytes, run.pdfSha256);
  return bytes;
}

function sourceAssets(run: StoredRun, result: ClientResult, files?: CodeFile[]) {
  const prefix = assetPrefix(run.userId!, run.runId), assets: SourceAsset[] = [];
  if (files) return files.map(f => ({ id: codeAssetId(f.path), page: 0, kind: 'code' as const, path: prefix + codeAssetId(f.path) + '.txt' }));
  assets.push({ id: 'pdf', page: 0, kind: 'pdf', path: prefix + 'portfolio.pdf' });
  for (const page of [...new Set(result.questions.flatMap(q => q.pages))]) assets.push({ id: `page-${page}`, page, kind: 'page', path: `${prefix}page-${page}.png` });
  for (const q of result.questions) for (const a of q.anchors ?? []) if (a.box && !assets.some(s => s.id === a.assetId))
    assets.push({ id: a.assetId, page: a.page, box: a.box, kind: 'crop', path: prefix + a.assetId + '.png' });
  return assets;
}

export async function advanceRun(runId: string, userId: string) {
  const run = await ownedStatus(runId, userId);
  if (run.state !== 'running' || run.execution !== 'steps') return run;
  const config = settings(), token = randomUUID();
  const identity = { p_run_id: runId, p_user_id: userId, p_token: token };
  let checkpoint: Checkpoint | null = await rpc('proofolio_claim_analysis', { ...identity, p_version: config.version });
  if (!checkpoint) return ownedStatus(runId, userId);
  const signal = AbortSignal.timeout(240_000); // Finish/settle before Vercel's 300-second route deadline.
  const save = async (final?: StoredRun) => rpc('proofolio_save_analysis', { ...identity, p_checkpoint: checkpoint,
    p_stage: run.stage, p_event: run.lastEvent ?? null, p_final: final ? runPayload(final) : null });
  try {
    const bytes = await inputBytes(run);
    const code = run.track === 'coding' ? JSON.parse(bytes.toString('utf8')) as { files: CodeFile[]; name: string; commit?: string } : null;
    if (code) validateCodeFiles(code.files);
    if (checkpoint.result) {
      // Publish one image/file per invocation. A retry only reuses the identical object, never reruns AI.
      const raw = checkpoint.result;
      const result: ClientResult = run.track === 'coding' ? raw.client_result : toClientResult(raw);
      const expected = sourceAssets(run, result, code?.files), saved = checkpoint.assets ??= [];
      const asset = expected.find(a => !saved.some(s => s.id === a.id));
      if (asset) {
        if (asset.kind === 'code') await uploadAsset(asset.path!, Buffer.from(code!.files.find(f => codeAssetId(f.path) === asset.id)!.content), 'text/plain');
        else if (asset.kind !== 'pdf') {
          const { renderPng } = await import('../../../src/pdf.ts');
          await uploadAsset(asset.path!, await renderPng(bytes, asset.page, asset.box), 'image/png');
        }
        saved.push(asset);
      } else {
        await uploadAsset(assetPrefix(userId, runId) + 'analysis.json', Buffer.from(JSON.stringify(raw)), 'application/json');
        result.sourceAssets = expected;
        run.result = result; run.metrics = raw.metrics; run.schemaVersion = raw.schema_version;
        run.state = 'complete'; run.stage = 3; run.finishedAt = new Date().toISOString(); run.lastEvent = 'complete';
      }
      await save(run.state === 'complete' ? run : undefined);
      return run;
    }
    const work = await nextModel<ClientResult | AnalysisResult>(generate => code
      ? analyzeCode(code.files, code.name, generate, run.requestedQuestions)
      : analyzePdf(bytes, { track: run.track as 'design' | 'marketing', ...config.models, provider: 'openrouter',
          maxQuestions: run.requestedQuestions, generate, signal, onEvent: event => {
            run.stage = Math.min(2, Math.max(run.stage, stageOf(event, run.stage)));
            if (!['error', 'complete'].includes(event.type)) run.lastEvent = event.type;
          } }), checkpoint.calls, signal);
    if (work.result) {
      const metrics = resumedMetrics(checkpoint.calls, run.startedAt);
      checkpoint.result = code ? { schema_version: 'coding-0.1', client_result: { ...work.result, estimatedCostUsd: metrics.estimated_cost_usd },
        commit: code.commit ?? null, metrics } : { ...work.result, created_at: run.startedAt, metrics };
      run.lastEvent = 'source_storage';
    } else if (work.next) {
      const { request, key, attempt } = work.next, stats = freshMetrics(), started = performance.now();
      let reservation: string | undefined, actual: number | null = null, dispatchedAt = started;
      const budget: CostBudget = { provider: 'openrouter', blocked: false,
        async reserveUsd(model, usd) {
          reservation = randomUUID();
          const id = await rpc('proofolio_reserve_execution', { ...identity, p_id: reservation, p_key: key, p_model: model, p_usd: usd, p_limit: config.limit });
          if (id !== reservation) throw new BudgetError('비용 예약을 확인하지 못했어요.');
          dispatchedAt = performance.now();
          return id;
        },
        settleUsd(id, usd) {
          if (id !== reservation || !Number.isFinite(usd) || usd < 0) throw new BudgetError('실제 비용을 확인하지 못했어요.');
          actual = usd; return usd; // Persisted atomically with its response in onResponse below.
        },
        block() { budget.blocked = true; },
      };
      const session = openRouterSession(process.env.OPENROUTER_API_KEY || '', stats, budget, {
        signal, requestIntervalMs: 0, initialAttempt: attempt, deferRateLimitRetry: true,
        onResponse: async (kind, value, model) => {
          const raw = value as Record<string, any>;
          const updated: Checkpoint = { ...checkpoint!, calls: [...checkpoint!.calls, {
            key, kind, model, raw, usage: stats.usage.at(-1)!, elapsed_ms: Math.round(performance.now() - started),
          }] };
          const blocked = await rpc('proofolio_finish_execution', { ...identity, p_id: reservation, p_actual: actual,
            p_checkpoint: updated, p_wait_ms: Math.ceil(Math.max(0, OPENROUTER_REQUEST_INTERVAL_MS - (performance.now() - dispatchedAt), retryDelay(raw) ?? 0)) });
          checkpoint = updated; // Only acknowledge the checkpoint after the database commit.
          if (blocked) throw new BudgetError('실제 비용이 미확인이거나 승인 한도를 초과해 추가 호출을 중단했어요.');
        },
      });
      try { await session.generate(request); }
      catch (e) { if (!(e instanceof SchemaValidationError) && !(e instanceof RateLimitPause)) throw e; }
      finally { await session.close(); }
    }
    await save();
    return run;
  } catch (e) {
    if (checkpoint.result) {
      // The paid work is already checkpointed. A storage retry must not throw it away.
      await save().catch(() => {});
      throw new AnswerError('결과 파일 저장이 지연됐어요. 같은 실행을 다시 열면 AI 호출 없이 이어서 저장해요.', 503);
    }
    run.state = 'failed'; run.finishedAt = new Date().toISOString();
    run.error = e instanceof BudgetError ? '운영 예산 또는 AI 비용 확인 문제로 중단했어요. 추가 결제 요청은 보내지 않았어요.'
      : '분석 단계를 완료하지 못했어요. 저장된 응답은 보존했고 같은 유료 요청을 자동으로 반복하지 않아요.';
    run.metrics = resumedMetrics(checkpoint.calls, run.startedAt);
    await save(run); // If this fails, the lease and pending reservation remain: fail closed.
    return run;
  }
}
