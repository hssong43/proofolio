import { NextResponse } from 'next/server';
import { runUser } from '@/lib/server/access';
import { listRuns } from '@/lib/server/database';
import { AnswerError } from '@/lib/server/runner';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return NextResponse.json({ runs: await listRuns((await runUser(request)).id) }, { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (e) { return NextResponse.json({ error: '기록을 불러오지 못했어요.' }, { status: e instanceof AnswerError ? e.status : 503 }); }
}
