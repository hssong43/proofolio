import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/server/runner";
import { publicTest, resolveOpenTest } from "@/lib/server/candidate-access";
import { createSubmission } from "@/lib/server/store";
import { CANDIDATE_COOKIE, CANDIDATE_TTL_MS, cookieHeader, issueCandidateToken } from "@/lib/server/auth";
import { validateCandidate } from "@/lib/candidate";
import { sessionSecret } from "@/lib/server/secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "허용되지 않은 요청이에요." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const resolved = await resolveOpenTest(body?.code);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const info = validateCandidate(body);
  if (!info.ok) return NextResponse.json({ error: info.error }, { status: 400 });
  try {
    const submission = await createSubmission(resolved.test.id, info.candidate);
    const token = issueCandidateToken(resolved.test.id, submission.id, await sessionSecret());
    return NextResponse.json(
      { submissionId: submission.id, test: publicTest(resolved.test) },
      { headers: { "Set-Cookie": cookieHeader(CANDIDATE_COOKIE, token, request, CANDIDATE_TTL_MS / 1000) } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
