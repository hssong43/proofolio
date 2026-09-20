import { NextResponse } from "next/server";
import { publicTest, resolveOpenTest } from "@/lib/server/candidate-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const resolved = await resolveOpenTest(body?.code);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  return NextResponse.json(publicTest(resolved.test));
}
