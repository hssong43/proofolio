import { createHash } from 'node:crypto';
import { buildOpenRouterPayload, parseOpenRouterResponse, OPENROUTER_MAX_RATE_LIMIT_RETRIES } from './openrouter.ts';
import { freshMetrics, type Generate, type Metrics, type ModelRequest } from './llm.ts';

export const RESUME_VERSION = 'model-checkpoints-1';
export const MAX_STEP_CALLS = 120;
export type SavedCall = { key: string; kind: string; model: string; raw: Record<string, any>;
  usage: Metrics['usage'][number]; elapsed_ms: number };
export type Checkpoint = { calls: SavedCall[]; result?: any; assets?: Array<{ id: string; page: number;
  kind: 'pdf' | 'page' | 'crop' | 'code'; path?: string; box?: [number, number, number, number] }> };

export function requestKey(request: ModelRequest) {
  return createHash('sha256').update(JSON.stringify(buildOpenRouterPayload(request))).digest('hex');
}

export function retryDelay(raw: Record<string, any>): number | null {
  const limited = raw._http_status === 429 || raw._diagnostics?.upstream_code === 429 ||
    [raw.error, raw.choices?.[0]?.error].some(e => e?.code === 429 || e?.code === '429');
  if (!limited || raw._application_http_attempt > OPENROUTER_MAX_RATE_LIMIT_RETRIES) return null;
  const delay = Math.max(30_000 * 2 ** ((raw._application_http_attempt ?? 1) - 1), raw._retry_after_ms ?? 0);
  return delay <= 120_000 ? delay : null;
}

class NextModel extends Error {}
// ponytail: replay bounded PDF work instead of maintaining a second analysis pipeline.
// Only cached model responses replay; never resend a completed paid request. Cache renders if CPU becomes limiting.
export async function nextModel<T>(run: (generate: Generate) => Promise<T>, calls: SavedCall[], signal?: AbortSignal) {
  const cache = new Map(calls.map(c => [c.key, c]));
  let next: { key: string; request: ModelRequest; attempt: number } | undefined;
  const generate: Generate = async request => {
    signal?.throwIfAborted();
    const key = requestKey(request), old = cache.get(key);
    if (old && retryDelay(old.raw) === null) {
      if (old.model !== request.model || old.kind !== request.kind) throw new Error('저장한 모델 요청이 일치하지 않아요.');
      return parseOpenRouterResponse(structuredClone(old.raw), request.schema);
    }
    next ??= { key, request, attempt: old ? Number(old.raw._application_http_attempt) + 1 : 1 };
    throw new NextModel();
  };
  try { return { result: await run(generate), next: undefined }; }
  catch (e) {
    if (!(e instanceof NextModel) || !next) throw e;
    if (calls.length >= MAX_STEP_CALLS) throw new Error('분석 단계 상한에 도달했어요. 추가 호출하지 않았어요.');
    return { result: undefined, next };
  }
}

export function resumedMetrics(calls: SavedCall[], startedAt: string): Metrics {
  const stats = freshMetrics();
  stats.model_calls = calls.length;
  stats.total_ms = Math.max(0, Date.now() - Date.parse(startedAt));
  stats.usage = calls.map(c => c.usage);
  stats.stages = calls.map(c => ({ stage: c.kind, elapsed_ms: c.elapsed_ms, attempt: Number(c.raw._application_http_attempt ?? 1) }));
  for (const call of calls) {
    const cost = call.usage.cost_usd;
    if (typeof cost === 'number') stats.estimated_cost_usd += cost;
    for (const [metric, key] of [['input_tokens', 'promptTokenCount'], ['output_tokens', 'candidatesTokenCount'],
      ['total_tokens', 'totalTokenCount'], ['thinking_tokens', 'thinking_tokens'], ['cached_tokens', 'cached_tokens']] as const) {
      const value = call.usage[key];
      stats[metric] = stats[metric] === null || typeof value !== 'number' ? null : stats[metric] + value;
    }
  }
  return stats;
}
