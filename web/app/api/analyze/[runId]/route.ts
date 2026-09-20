import { NextResponse } from "next/server";
import { ownedStatus, AnswerError } from "@/lib/server/runner";
import { requireUser } from "@/lib/server/auth";
import { publicStatus, databaseAnswers, dbRequest } from "@/lib/server/database";
import { sameOrigin } from "@/lib/server/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  try {
    const user = await requireUser();
    const status = await ownedStatus(runId, user.id);
    if (status.state === 'complete') status.answers = await databaseAnswers(runId);
    return NextResponse.json(publicStatus(status), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: "실행을 찾을 수 없어요." }, { status: e instanceof AnswerError ? e.status : 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: '허용되지 않는 요청이에요.' }, { status: 403 });
  try {
    const user = await requireUser(), { runId } = await context.params, run = await ownedStatus(runId, user.id);
    if (run.state === 'running' || run.state === 'queued') return NextResponse.json({ error: '진행 중에는 삭제할 수 없어요.' }, { status: 409 });
    await dbRequest(`/rest/v1/proofolio_runs?id=eq.${runId}&user_id=eq.${user.id}`, { method: 'PATCH',
      body: JSON.stringify({ deleted_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }) });
    return NextResponse.json({ ok: true, message: '목록에서 숨겼어요. 7일 후 원문과 기록이 정리돼요.' });
  } catch (e) { return NextResponse.json({ error: '기록을 삭제하지 못했어요.' }, { status: e instanceof AnswerError ? e.status : 503 }); }
}
