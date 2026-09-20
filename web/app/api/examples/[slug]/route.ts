import { NextResponse } from 'next/server';
import { example } from '@/lib/server/database';
import { contestSettings } from '@/lib/server/contest';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const contest=contestSettings();
  if(contest.enabled&&contest.closed)return NextResponse.json({error:'대회 체험이 종료됐어요.'},{status:410,headers:{'Cache-Control':'no-store'}});
  try {
    const item = await example((await context.params).slug);
    // Only curated question text is public. Source PDFs, asset paths, metrics and owners remain private.
    const { sourceAssets: _assets, ...result } = item.result;
    return NextResponse.json({ title: item.title, notice: item.notice, result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: '예제가 준비되지 않았어요. 잠시 후 다시 시도해주세요.' }, { status: 503 }); }
}
