import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/server/runner";
import { isAdminRequest } from "@/lib/server/auth";
import { createTest } from "@/lib/server/store";
import { validatePeriod } from "@/lib/period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TITLE_MAX = 80;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "허용되지 않은 요청이에요." }, { status: 403 });
  if (!isAdminRequest(request)) return NextResponse.json({ error: "로그인이 필요해요." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { title?: unknown; startsAt?: unknown; endsAt?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title || title.length > TITLE_MAX) return NextResponse.json({ error: `제목은 1~${TITLE_MAX}자로 입력해주세요.` }, { status: 400 });
  const period = validatePeriod(body?.startsAt, body?.endsAt);
  if (!period.ok) return NextResponse.json({ error: period.error }, { status: 400 });
  try {
    const test = await createTest({ title, startsAt: period.startsAt, endsAt: period.endsAt });
    return NextResponse.json({ test }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
