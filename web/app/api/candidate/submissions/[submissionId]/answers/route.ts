import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/server/runner";
import { candidateOf } from "@/lib/server/auth";
import { completeSubmission, getTest } from "@/lib/server/store";
import { sessionSecret } from "@/lib/server/secret";
import { ANSWER_MAX_LENGTH, ROLES } from "@/lib/data";
import type { CompletionPayload, UiQuestion } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const strList = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").map((s) => (s as string).slice(0, max)) : []);

function sanitize(body: Record<string, unknown>, roleId: string): CompletionPayload | null {
  // 직무는 응시자 입력이 아니라 테스트에 고정된 값을 쓴다.
  const role = ROLES.find((r) => r.id === roleId);
  if (!role || !Array.isArray(body.questions) || !Array.isArray(body.answers)) return null;
  const questions: UiQuestion[] = body.questions.slice(0, 20).map((q) => {
    const raw = (q ?? {}) as Record<string, unknown>;
    return { id: str(raw.id, 64), prompt: str(raw.prompt, 2000), quotes: strList(raw.quotes, 2000), notes: strList(raw.notes, 500), source: str(raw.source, 300) };
  });
  const answers = body.answers.slice(0, 20).map((a) => {
    const raw = (a ?? {}) as Record<string, unknown>;
    return { questionId: str(raw.questionId, 64), answer: str(raw.answer, ANSWER_MAX_LENGTH), seconds: Number(raw.seconds) || 0 };
  });
  const elapsed = Number(body.elapsedSeconds);
  return { role: role.id, roleLabel: role.label, questions, answers, elapsedSeconds: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : 0, runId: typeof body.runId === "string" ? body.runId : null };
}

export async function POST(request: Request, context: { params: Promise<{ submissionId: string }> }) {
  const { submissionId } = await context.params;
  if (!sameOrigin(request)) return NextResponse.json({ error: "허용되지 않은 요청이에요." }, { status: 403 });
  const session = candidateOf(request, submissionId, await sessionSecret());
  if (!session) return NextResponse.json({ error: "응시 세션이 없어요. 코드 입력부터 다시 진행해주세요." }, { status: 401 });
  const test = await getTest(session.testId).catch(() => null);
  if (!test) return NextResponse.json({ error: "테스트를 찾을 수 없어요." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const payload = body && sanitize(body, test.role);
  if (!payload) return NextResponse.json({ error: "저장할 답변 형식이 올바르지 않아요." }, { status: 400 });
  try {
    const submission = await completeSubmission(session.testId, submissionId, payload);
    return NextResponse.json({ ok: true, submissionId: submission.id, answered: submission.answers?.length ?? 0 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
}
