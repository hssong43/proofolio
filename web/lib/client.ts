import type { AnswerRecord, PortfolioExample, RunStatus, Track } from "./types";

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `요청 실패 (${res.status})`);
  return body;
}

export async function startAnalysis(file: File, track: Track, maxQuestions: number, submissionId?: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("track", track);
  form.append("maxQuestions", String(maxQuestions));
  if(submissionId)form.append('submissionId',submissionId);
  return parse<{ runId: string }>(await fetch("/api/analyze", { method: "POST", body: form }));
}

export async function fetchStatus(runId: string) {
  return parse<RunStatus>(await fetch(`/api/analyze/${runId}`, { cache: "no-store" }));
}

export async function fetchExample(track: Track) {
  return parse<PortfolioExample>(await fetch(`/api/examples/${track}`, { cache: 'no-store' }));
}
export async function startCodeAnalysis(url: string, maxQuestions: number, submissionId?: string) {
  return parse<{runId: string}>(await fetch('/api/analyze/code', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url,maxQuestions,submissionId}) }));
}
export async function submitAnswer(runId: string, answer: AnswerRecord) {
  const result = await parse<{ok: boolean; saved: string; answers: AnswerRecord[]}>(await fetch(`/api/analyze/${runId}/answers`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(answer) }));
  const saved = result.answers?.find(a => a.questionId === answer.questionId);
  if (!result.ok || result.saved !== answer.questionId || saved?.answer !== answer.answer || saved.seconds !== answer.seconds)
    throw new Error('저장 응답을 확인하지 못했어요. 같은 답변으로 다시 시도해주세요.');
  return result.answers;
}

export async function submitAnswers(runId: string, answers: AnswerRecord[]) {
  const result = await parse<{ ok: boolean; saved: number; storage: "local" | "supabase" }>(await fetch(`/api/analyze/${runId}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }) }));
  if (result.ok !== true || result.saved !== answers.length) throw new Error("저장 응답의 답변 개수를 확인할 수 없어요.");
  return result;
}

export async function recruitingRequest<T>(url: string, body?: unknown, method=body===undefined?'GET':'POST'): Promise<T> {
  return parse<T>(await fetch(url,{method,cache:'no-store',
    ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}));
}

/** 담당자가 완료된 제출을 다시 채점한다. 결과는 상세 조회로 확인한다. */
export function rescoreSubmission(testId: string, submissionId: string) {
  return recruitingRequest<{ ok: true; state: 'running' }>('/api/admin/tests/' + testId + '/submissions/' + submissionId + '/score', {});
}
