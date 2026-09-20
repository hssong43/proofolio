import { NextResponse } from 'next/server';
import { runUser } from '@/lib/server/access';
import { AnswerError, sameOrigin } from '@/lib/server/runner';
import { advanceRun } from '@/lib/server/steps';
import { publicStatus } from '@/lib/server/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!sameOrigin(request)) return NextResponse.json({ error: '같은 사이트에서만 요청할 수 있어요.' }, { status: 403, headers });
  try {
    const user = await runUser(request), { runId } = await context.params;
    return NextResponse.json(publicStatus(await advanceRun(runId, user.id)), { headers });
  } catch (e) {
    return NextResponse.json({ error: e instanceof AnswerError ? e.message : '단계 실행 상태를 확인하지 못했어요. 같은 실행에서 다시 확인해주세요.' },
      { status: e instanceof AnswerError ? e.status : 503, headers });
  }
}
