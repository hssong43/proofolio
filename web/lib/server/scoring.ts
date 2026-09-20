import { loadRuntimeEnv, executionBudget } from '../../../src/env.ts';
import { Budget, freshMetrics } from '../../../src/llm.ts';
import type { Generate } from '../../../src/llm.ts';
import { OPENROUTER_MODELS, openRouterModel, openRouterSession, validateOpenRouterKey } from '../../../src/openrouter.ts';
import { modelRequest } from '../../../src/questions.ts';
import { scoreAnswers } from '../../../src/scoring.ts';
import type { ScoreItem, SubmissionScore } from '../types.ts';
import { databaseAnswers, databaseRun, dbRequest, rpc } from './database.ts';
import { ROOT } from './runner.ts';

type ScoreRow = { submission_id: string; state: SubmissionScore['state']; model: string | null; overall_score: number | null;
  items: ScoreItem[]; error: string | null; scored_at: string | null; cost_usd: number | string | null };

export const toScore = (r: ScoreRow): SubmissionScore => ({ state: r.state, model: r.model, overallScore: r.overall_score,
  items: Array.isArray(r.items) ? r.items : [], error: r.error, scoredAt: r.scored_at, costUsd: r.cost_usd === null ? null : Number(r.cost_usd) });

/** 여러 제출의 점수를 한 번에 읽는다. 없는 제출은 결과에 없다. */
export async function scoresFor(submissionIds: string[]): Promise<Map<string, SubmissionScore>> {
  const ids = submissionIds.filter(id => /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length) return new Map();
  const rows: ScoreRow[] = await dbRequest('/rest/v1/proofolio_submission_scores?submission_id=in.(' + ids.join(',') + ')&select=*');
  return new Map((rows ?? []).map(r => [r.submission_id, toScore(r)]));
}

export function scoringModel(env: NodeJS.ProcessEnv = process.env): string {
  const model = env.OPENROUTER_SCORING_MODEL || OPENROUTER_MODELS.questions;
  openRouterModel(model); // throws for unknown ids
  return model;
}

async function saveScore(submissionId: string, userId: string, score: Partial<SubmissionScore> & { state: SubmissionScore['state'] }) {
  const saved = await rpc('proofolio_save_submission_score', { p_submission_id: submissionId, p_user_id: userId, p_score: score });
  if (saved !== submissionId) throw new Error('채점 저장 응답을 확인하지 못했어요.');
}

const inflight = new Set<string>();
const publicMessage = (e: unknown) => {
  const message = e instanceof Error ? e.message : '채점에 실패했어요.';
  // Never persist key material or provider bodies.
  return message.replace(/sk-or-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 400);
};

export type ScoringJob = { submissionId: string; userId: string; runId: string };

/**
 * 완료된 제출의 답변을 채점해 DB에 저장한다. 멱등: 이미 complete면 다시 호출하지 않는다.
 * 모델 호출은 공용 OpenRouter 세션·예산 원장을 그대로 쓴다. 실패는 상태로 남기고 예외를 던지지 않는다.
 */
export async function scoreSubmission(job: ScoringJob, options: { generate?: Generate; force?: boolean } = {}): Promise<SubmissionScore['state']> {
  if (inflight.has(job.submissionId)) return 'running';
  inflight.add(job.submissionId);
  let budget: Budget | undefined, session: ReturnType<typeof openRouterSession> | undefined;
  try {
    const existing = (await scoresFor([job.submissionId])).get(job.submissionId);
    if (existing?.state === 'complete' && !options.force) return 'complete';
    const env = process.env;
    loadRuntimeEnv(ROOT, env);
    const model = scoringModel(env);
    await saveScore(job.submissionId, job.userId, { state: 'running', model });
    const [run, answers] = await Promise.all([databaseRun(job.runId), databaseAnswers(job.runId)]);
    if (!run || run.userId !== job.userId || !run.result) throw new Error('채점할 실행 결과를 찾을 수 없어요.');
    const questions = run.result.questions.map(q => ({ id: q.id, prompt: q.prompt, intent: q.intent, listenFor: q.listenFor }));
    const stats = freshMetrics();
    let generate = options.generate;
    if (!generate && env.PROOFOLIO_SCORING_MOCK === '1') generate = (await import('./scoring-mock.ts')).mockScoringGenerate; // TEMPORARY mock
    if (!generate) {
      const { limit, ledger } = executionBudget(ROOT, env);
      validateOpenRouterKey(env.OPENROUTER_API_KEY);
      try { budget = new Budget(ledger, limit, 'openrouter'); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('다른 분석이 진행 중이에요. 잠시 후 다시 채점해주세요.');
        throw e;
      }
      session = openRouterSession(env.OPENROUTER_API_KEY, stats, budget);
      generate = session.generate;
    }
    const request = modelRequest(generate, stats, { model, scoringModel: model });
    const result = await scoreAnswers({ questions, answers: answers.map(a => ({ questionId: a.questionId, answer: a.answer })) }, request);
    await saveScore(job.submissionId, job.userId, { state: 'complete', model, overallScore: result.overallScore, items: result.items, costUsd: stats.estimated_cost_usd });
    return 'complete';
  } catch (e) {
    try { await saveScore(job.submissionId, job.userId, { state: 'failed', error: publicMessage(e) }); } catch { /* 저장 실패는 상태 조회에서 미채점으로 보인다 */ }
    return 'failed';
  } finally {
    inflight.delete(job.submissionId);
    try { await session?.close(); } finally { budget?.close(); }
  }
}

export const isScoring = (submissionId: string) => inflight.has(submissionId);
