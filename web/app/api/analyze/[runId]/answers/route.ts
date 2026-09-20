import { NextResponse } from "next/server";
import { saveAnswers, saveAnswer, sameOrigin, AnswerError, ownedStatus } from "@/lib/server/runner";
import { runUser } from "@/lib/server/access";
import type { AnswerRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "같은 사이트에서만 답변을 저장할 수 있어요." }, { status: 403 });
  const { runId } = await context.params;
  if (Number(request.headers.get("content-length")) > 100_000)
    return NextResponse.json({ error: "답변 요청이 너무 커요." }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { answers?: AnswerRecord[] } | null;
  if (!body || !Array.isArray(body.answers)) return NextResponse.json({ error: "answers 배열이 필요해요." }, { status: 400 });
  try {
    const status = await ownedStatus(runId, (await runUser(request)).id);
    const saved = await saveAnswers(runId, body.answers);
    return NextResponse.json({ ok: true, saved, storage: status.storage ?? "local" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof AnswerError ? e.message : "답변 저장에 실패했어요. 다시 시도해주세요." }, { status: e instanceof AnswerError ? e.status : 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: '허용되지 않는 요청이에요.' }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 4096) return NextResponse.json({ error: '답변이 너무 길어요.' }, { status: 413 });
    const answer = JSON.parse(text) as AnswerRecord;
    const { runId } = await context.params, user = await runUser(request);
    const answers = await saveAnswer(runId, user.id, answer);
    return NextResponse.json({ ok: true, saved: answer.questionId, answers, storage: 'supabase' });
  } catch (e) {
    return NextResponse.json({ error: e instanceof AnswerError ? e.message : '답변을 저장하지 못했어요. 같은 답변으로 다시 시도해주세요.' }, { status: e instanceof AnswerError ? e.status : 503 });
  }
}
