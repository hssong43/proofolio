import { NextResponse } from "next/server";
import { saveAnswers, sameOrigin, AnswerError } from "@/lib/server/runner";
import type { AnswerRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "같은 사이트에서만 답변을 저장할 수 있어요." }, { status: 403 });
  const { runId } = await context.params;
  const body = (await request.json().catch(() => null)) as { answers?: AnswerRecord[] } | null;
  if (!body || !Array.isArray(body.answers)) return NextResponse.json({ error: "answers 배열이 필요해요." }, { status: 400 });
  try {
    const saved = await saveAnswers(runId, body.answers);
    return NextResponse.json({ ok: true, saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof AnswerError ? e.message : "답변 저장에 실패했어요. 다시 시도해주세요." }, { status: e instanceof AnswerError ? e.status : 500 });
  }
}
