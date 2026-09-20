import { NextResponse } from 'next/server';
import { exampleAssetPath } from '@/lib/server/database';
import { storageClient, PRIVATE_BUCKET } from '@/lib/server/assets';
import { contestSettings } from '@/lib/server/contest';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const contest = contestSettings();
  if (contest.enabled && contest.closed) return NextResponse.json({ error: '프리뷰가 종료됐어요.' }, { status: 410, headers });
  try {
    const path = await exampleAssetPath((await context.params).slug, 'pdf');
    if (!path) return NextResponse.json({ error: '예제 포트폴리오를 찾을 수 없어요.' }, { status: 404, headers });
    // Serve the existing large PDF directly from private Storage, not through the web response body.
    const { data, error } = await storageClient().storage.from(PRIVATE_BUCKET).createSignedUrl(path, 300);
    if (error || !data) throw new Error('Portfolio unavailable');
    return NextResponse.redirect(data.signedUrl, { status: 307, headers });
  } catch {
    return NextResponse.json({ error: '포트폴리오를 불러오지 못했어요. 다시 열어주세요.' }, { status: 503, headers });
  }
}
