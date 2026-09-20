import type { AnswerRecord, ClientResult, RunStatus, Track } from "../types.ts";
import { createHash } from "node:crypto";
import { loadRuntimeEnv } from "../../../src/env.ts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export type StoredRun = RunStatus & {
  userId?: string;
  pdfSha256?: string;
  requestedQuestions?: number;
  metrics?: unknown;
  schemaVersion?: string;
};

export function storageMode(env = process.env): "local" | "supabase" {
  const mode = env.PROOFOLIO_STORAGE || "local";
  if (mode !== "local" && mode !== "supabase") throw new Error("PROOFOLIO_STORAGE는 local 또는 supabase여야 해요.");
  return mode;
}

export async function dbRequest(path: string, init: RequestInit = {}) {
  if (!path.startsWith('/rest/v1/') || path.includes('..') || path.includes('\\')) throw new Error('잘못된 DB 요청 경로예요.');
  loadRuntimeEnv(resolve(process.env.PROOFOLIO_ROOT ?? (existsSync('src/cli.ts') ? '.' : '..')));
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  let url: URL;
  try { url = new URL(process.env.SUPABASE_URL ?? ""); }
  catch { throw new Error("Supabase URL과 서버 전용 키를 설정해주세요."); }
  if (!key || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))))
    throw new Error("Supabase URL과 서버 전용 키를 설정해주세요.");
  let response: Response;
  try {
    response = await fetch(new URL(path, url), {
      ...init, headers: { apikey: key, "Content-Type": "application/json",
        ...(!key.startsWith("sb_secret_") ? { Authorization: `Bearer ${key}` } : {}), ...init.headers },
      signal: AbortSignal.timeout(30000), redirect: "error", cache: "no-store",
    });
  } catch { throw new Error("Supabase 저장 서버에 연결하지 못했어요. 답변 저장만 다시 시도해주세요."); }
  // Never forward provider bodies, SQL diagnostics, credentials or user content to the browser/log.
  if (!response.ok) throw new Error(`Supabase 저장 실패 (${response.status}). SQL 적용·서버 키를 확인해주세요.`);
  try { const text = await response.text(); return text ? JSON.parse(text) : null; }
  catch { throw new Error("Supabase 저장 응답을 확인하지 못했어요."); }
}
export const rpc = (name: string, body: unknown) => dbRequest(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });

export async function ensureMember(id: string, authId: string) {
  await dbRequest('/rest/v1/proofolio_users?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ id, auth_user_id: authId }) });
}

export function runPayload(status: StoredRun) {
  return { id: status.runId, user_id: status.userId, track: status.track, file_name: status.fileName,
    pdf_sha256: status.pdfSha256, requested_question_count: status.requestedQuestions,
    state: status.state, started_at: status.startedAt, finished_at: status.finishedAt ?? null,
    error: status.error ?? null, result: status.result ?? null, metrics: status.metrics ?? null,
    schema_version: status.schemaVersion ?? null };
}

export async function syncRun(status: StoredRun) {
  if (status.storage !== "supabase") return;
  if (!status.userId) throw new Error("실행의 사용자 정보가 없어요.");
  const value = await rpc("proofolio_sync_run", { p_run: runPayload(status) });
  if (value !== status.runId) throw new Error("Supabase 실행 저장 응답이 일치하지 않아요.");
}

export async function databaseRun(runId: string): Promise<StoredRun | null> {
  const rows = await dbRequest(`/rest/v1/proofolio_runs?id=eq.${encodeURIComponent(runId)}&deleted_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*&limit=1`);
  const r = rows?.[0];
  if (!r) return null;
  return { runId: r.id, userId: r.user_id, track: r.track, fileName: r.file_name, pdfSha256: r.pdf_sha256,
    requestedQuestions: r.requested_question_count, state: r.state, stage: r.state === 'complete' ? 3 : r.progress_stage ?? 0,
    execution: r.execution ?? 'local', lastEvent: r.last_event ?? undefined,
    startedAt: r.started_at, finishedAt: r.finished_at ?? undefined, error: r.error ?? undefined,
    result: r.result ?? undefined, metrics: r.metrics, schemaVersion: r.schema_version, storage: 'supabase' };
}
export async function databaseAnswers(runId: string): Promise<AnswerRecord[]> {
  const rows = await dbRequest(`/rest/v1/proofolio_answers?run_id=eq.${encodeURIComponent(runId)}&select=question_id,answer,seconds`);
  return rows.map((r: { question_id: string; answer: string; seconds: number }) => ({ questionId: r.question_id, answer: r.answer, seconds: r.seconds }));
}
export async function listRuns(userId: string) {
  return dbRequest(`/rest/v1/proofolio_runs?user_id=eq.${userId}&deleted_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id,track,file_name,state,started_at,finished_at,generated_question_count,error&order=started_at.desc&limit=50`);
}
export const EXAMPLE_LIBRARY_OWNER = createHash('sha256').update('proofolio:private-example-library:v1').digest('hex');
export async function example(slug: string): Promise<{ slug: Track; title: string; source_run_id: string; result: ClientResult; notice: string }> {
  if (!['design','marketing','coding'].includes(slug)) throw new Error('지원하지 않는 예제예요.');
  const rows = await dbRequest(`/rest/v1/proofolio_examples?slug=eq.${slug}&select=slug,title,source_run_id,result,notice&limit=1`);
  if (!rows?.[0]) throw new Error('예제 데이터가 아직 준비되지 않았어요.');
  return rows[0];
}

// Only curated PDFs and their linked page images are public, never visitor runs.
export async function exampleAssetPath(slug: string, page: number | 'pdf'): Promise<string | null> {
  if (!['design','marketing'].includes(slug) || (page !== 'pdf' && (!Number.isSafeInteger(page) || page < 1 || page > 60))) return null;
  const item = await example(slug);
  if ((page !== 'pdf' && !item.result.questions.some(q => q.pages.includes(page))) || !/^[a-f0-9-]{36}$/.test(item.source_run_id)) return null;
  const rows = await dbRequest(`/rest/v1/proofolio_runs?id=eq.${item.source_run_id}&deleted_at=is.null&state=eq.complete&select=user_id,track,result&limit=1`);
  const run = rows?.[0] as { user_id: string; track: Track; result: ClientResult } | undefined;
  if (run?.user_id !== EXAMPLE_LIBRARY_OWNER || run.track !== slug) return null;
  const path = `${EXAMPLE_LIBRARY_OWNER}/${item.source_run_id}/${page === 'pdf' ? 'portfolio.pdf' : `page-${page}.png`}`;
  const asset = run.result?.sourceAssets?.find(a => page === 'pdf'
    ? a.kind === 'pdf' && a.page === 0 && a.id === 'pdf'
    : a.kind === 'page' && a.page === page && a.id === `page-${page}`);
  return asset?.path === path ? path : null;
}

export async function syncAnswers(status: StoredRun, answers: AnswerRecord[]) {
  if (status.storage !== "supabase") return;
  await syncRun(status); // A failed final-result sync can be retried without re-running analysis.
  const value = await rpc("proofolio_save_answers", { p_run_id: status.runId, p_user_id: status.userId, p_answers: answers });
  if (value !== answers.length) throw new Error("Supabase 답변 저장 개수가 일치하지 않아요.");
}

export function publicStatus(status: StoredRun): RunStatus {
  const { userId: _user, pdfSha256: _hash, requestedQuestions: _requested, metrics: _metrics, schemaVersion: _schema, ...visible } = status;
  if (visible.state === 'failed' && visible.error?.includes('현재 Vercel 배포에는 장시간 분석 실행 환경이 연결되지'))
    visible.error = '이 기록은 이전 배포에서 분석을 시작하지 못하고 종료됐어요. 최신 버전에서 새 분석을 준비하거나 예제를 체험해주세요.';
  return { ...visible, ...(visible.result ? { result: { ...visible.result,
    sourceAssets: visible.result.sourceAssets?.map(({ path: _path, ...asset }) => asset) } } : {}) };
}
