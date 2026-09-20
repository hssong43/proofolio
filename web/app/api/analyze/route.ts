import { NextResponse } from "next/server";
import { DEFAULT_MAX_QUESTIONS, startRun, sameOrigin } from "@/lib/server/runner";
import type { Track } from "@/lib/types";
import { runUser } from "@/lib/server/access";
import { ensureMember } from '@/lib/server/database';
import { AnswerError } from "@/lib/server/runner";
import { MIN_TARGET_QUESTIONS, MAX_PDF_BYTES } from "../../../../src/constants.ts";
import { authorizeCandidateAnalysis } from '@/lib/server/recruiting';
import { finishPdfUpload, uploadJson } from '@/lib/server/upload';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "같은 사이트에서만 분석을 시작할 수 있어요." }, { status: 403 });
  if (request.headers.get('content-type')?.startsWith('application/json')) {
    try {
      const user = await runUser(request), body = await uploadJson(request);
      return NextResponse.json(await finishPdfUpload(body?.runId, user), { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (e) {
      return NextResponse.json({ error: e instanceof AnswerError ? e.message : 'PDF는 업로드됐지만 분석을 시작하지 못했어요.' },
        { status: e instanceof AnswerError ? e.status : 503, headers: { 'Cache-Control': 'private, no-store' } });
    }
  }
  // Legacy multipart remains available on a persistent local server, never for the deployed browser flow.
  if (Number(request.headers.get("content-length")) > MAX_PDF_BYTES + 1_000_000)
    return NextResponse.json({ error: "PDF는 50MB 이하여야 해요." }, { status: 413 });
  const form = await request.formData();
  const file = form.get("file");
  const track = form.get("track");
  const maxQuestionsRaw = Number(form.get("maxQuestions") ?? DEFAULT_MAX_QUESTIONS);
  if (!(file instanceof File)) return NextResponse.json({ error: "PDF 파일이 필요해요." }, { status: 400 });
  if (track !== "design" && track !== "marketing") return NextResponse.json({ error: "지원하지 않는 직무예요." }, { status: 400 });
  if (file.size === 0 || file.size > MAX_PDF_BYTES) return NextResponse.json({ error: "PDF는 50MB 이하여야 해요." }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 5 || !bytes.subarray(0, 5).every((b, i) => b === "%PDF-".charCodeAt(i))) return NextResponse.json({ error: "PDF 파일만 올릴 수 있어요." }, { status: 400 });
  if (!Number.isInteger(maxQuestionsRaw) || maxQuestionsRaw < MIN_TARGET_QUESTIONS || maxQuestionsRaw > DEFAULT_MAX_QUESTIONS)
    return NextResponse.json({ error: `질문 수는 ${MIN_TARGET_QUESTIONS}~${DEFAULT_MAX_QUESTIONS}개예요.` }, { status: 400 });
  const maxQuestions = maxQuestionsRaw;
  try {
    const user = await runUser(request);
    if(user.member)await ensureMember(user.id,user.authId);
    if(form.has('submissionId')) {
      if (!user.member) throw new AnswerError('프리뷰에서는 채용 응시 정보를 받지 않아요.', 403);
      await authorizeCandidateAnalysis(form.get('submissionId'),user.id,track,maxQuestions);
    }
    const status = await startRun({ bytes, fileName: file.name, track: track as Track, maxQuestions, userId: user.id, member: user.member, guestExpiresAt: user.guestExpiresAt });
    return NextResponse.json({ runId: status.runId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof AnswerError ? e.status : 500 });
  }
}
