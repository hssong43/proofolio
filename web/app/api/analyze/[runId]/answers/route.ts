import { NextResponse } from "next/server";
import { saveAnswers, sameOrigin } from "@/lib/server/runner";
import type { AnswerRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "같은 사이트에서만 답변을 저장할 수 있어요." }, { status: 403 });
  const { runId } = await context.params;
  const body = (await request.json().catch(() => null)) as { answers?: AnswerRecord[] } | null;
  if (!body || !Array.isArray(body.answers)) return NextResponse.json({ error: "answers 배열이 필요해요." }, { status: 400 });
  const answers = body.answers
    .filter((a) => typeof a?.questionId === "string" && typeof a?.answer === "string")
    .map((a) => ({ questionId: a.questionId, answer: a.answer.slice(0, 500), seconds: Number(a.seconds) || 0 }));
  try {
    await saveAnswers(runId, answers);
    return NextResponse.json({ ok: true, saved: answers.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
}
