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
  return parse<{ ok: true }>(await fetch(`/api/analyze/${runId}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }) }));
}

/* ---------- 응시자 (테스트 코드 참여) ---------- */

import type { CompletionPayload, PublicTest } from "./types";

export async function checkCode(code: string) {
  return parse<PublicTest>(await fetch("/api/candidate/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }));
}

export async function joinTest(input: { code: string; name: string; birthDate: string; phone: string }) {
  return parse<{ submissionId: string; test: PublicTest }>(await fetch("/api/candidate/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export async function completeSubmission(submissionId: string, payload: CompletionPayload) {
  return parse<{ ok: true }>(await fetch(`/api/candidate/submissions/${submissionId}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
}
