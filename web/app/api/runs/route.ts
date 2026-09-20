import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { listRuns } from '@/lib/server/database';
import { AnswerError } from '@/lib/server/runner';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return NextResponse.json({ runs: await listRuns((await requireUser()).id) }, { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (e) { return NextResponse.json({ error: '기록을 불러오지 못했어요.' }, { status: e instanceof AnswerError ? e.status : 503 }); }
}
