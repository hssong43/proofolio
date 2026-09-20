import { NextResponse } from 'next/server';
import { runUser } from '@/lib/server/access';
import { ensureMember } from '@/lib/server/database';
import { AnswerError, sameOrigin } from '@/lib/server/runner';
import { authorizeCandidateAnalysis } from '@/lib/server/recruiting';
import { cancelPdfUpload, preparePdfUpload, uploadJson, uploadMetadata } from '@/lib/server/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: '허용되지 않는 요청이에요.' }, { status: 403, headers });
  try {
    const user = await runUser(request), metadata = uploadMetadata(await uploadJson(request));
    if (user.member) await ensureMember(user.id, user.authId);
    if (metadata.submissionId) {
      if (!user.member) throw new AnswerError('대회 체험에서는 채용 응시 정보를 받지 않아요.', 403);
      await authorizeCandidateAnalysis(metadata.submissionId, user.id, metadata.track, metadata.maxQuestions);
    }
    return NextResponse.json(await preparePdfUpload(metadata, user), { headers });
  } catch (e) {
    return NextResponse.json({ error: e instanceof AnswerError ? e.message : '업로드 준비에 실패했어요. Storage와 비회원 체험 SQL 설정을 확인해주세요.' },
      { status: e instanceof AnswerError ? e.status : 503, headers });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: '허용되지 않는 요청이에요.' }, { status: 403, headers });
  try {
    const user = await runUser(request), body = await uploadJson(request);
    await cancelPdfUpload(body?.runId, user);
    return NextResponse.json({ ok: true }, { headers });
  } catch (e) {
    return NextResponse.json({ error: '업로드 취소를 확인하지 못했어요.' }, { status: e instanceof AnswerError ? e.status : 503, headers });
  }
}
