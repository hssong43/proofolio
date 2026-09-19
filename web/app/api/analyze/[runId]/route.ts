import { NextResponse } from "next/server";
import { readStatus } from "@/lib/server/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  try {
    const status = await readStatus(runId);
    if (!status) return NextResponse.json({ error: "실행을 찾을 수 없어요." }, { status: 404 });
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
