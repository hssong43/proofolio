import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/server/runner";
import { adminOf } from "@/lib/server/auth";
import { sessionSecret } from "@/lib/server/secret";
import { createTest, DEFAULT_PASS_SCORE } from "@/lib/server/store";
import { validatePeriod } from "@/lib/period";
import { ROLES } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TITLE_MAX = 80;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "허용되지 않은 요청이에요." }, { status: 403 });
  const admin = adminOf(request, await sessionSecret());
  if (!admin) return NextResponse.json({ error: "로그인이 필요해요." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { title?: unknown; role?: unknown; startsAt?: unknown; endsAt?: unknown; passScore?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title || title.length > TITLE_MAX) return NextResponse.json({ error: `제목은 1~${TITLE_MAX}자로 입력해주세요.` }, { status: 400 });
  const role = ROLES.find((r) => r.id === body?.role);
  if (!role) return NextResponse.json({ error: "직무를 선택해주세요." }, { status: 400 });
  const passScore = body?.passScore === undefined ? DEFAULT_PASS_SCORE : Number(body.passScore);
  if (!Number.isInteger(passScore) || passScore < 0 || passScore > 100) return NextResponse.json({ error: "통과 점수는 0~100 사이 정수예요." }, { status: 400 });
  const period = validatePeriod(body?.startsAt, body?.endsAt);
  if (!period.ok) return NextResponse.json({ error: period.error }, { status: 400 });
  try {
    const test = await createTest({ title, role: role.id, startsAt: period.startsAt, endsAt: period.endsAt, passScore, createdBy: admin.accountId });
    return NextResponse.json({ test }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
