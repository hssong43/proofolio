import type { AnswerRecord, RunStatus, Track } from "./types";

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `요청 실패 (${res.status})`);
  return body;
}

export async function startAnalysis(file: File, track: Track, maxQuestions: number) {
  const form = new FormData();
  form.append("file", file);
  form.append("track", track);
  form.append("maxQuestions", String(maxQuestions));
  return parse<{ runId: string }>(await fetch("/api/analyze", { method: "POST", body: form }));
}

export async function fetchStatus(runId: string) {
  return parse<RunStatus>(await fetch(`/api/analyze/${runId}`, { cache: "no-store" }));
}

export async function submitAnswers(runId: string, answers: AnswerRecord[]) {
  const result = await parse<{ ok: boolean; saved: number }>(await fetch(`/api/analyze/${runId}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }) }));
  if (result.ok !== true || result.saved !== answers.length) throw new Error("저장 응답의 답변 개수를 확인할 수 없어요.");
  return result;
}
