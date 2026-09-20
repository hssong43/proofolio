import { NextResponse } from 'next/server';
import { exampleAssetPath } from '@/lib/server/database';
import { storageClient, PRIVATE_BUCKET } from '@/lib/server/assets';
import { contestSettings } from '@/lib/server/contest';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const contest = contestSettings();
  if (contest.enabled && contest.closed) return NextResponse.json({ error: '프리뷰가 종료됐어요.' }, { status: 410, headers });
  const { slug } = await context.params, value = new URL(request.url).searchParams.get('page') ?? '';
  if (!['design', 'marketing'].includes(slug) || !/^[1-9]\d?$/.test(value))
    return NextResponse.json({ error: '예제 이미지를 찾을 수 없어요.' }, { status: 404, headers });
  try {
    const path = await exampleAssetPath(slug, Number(value));
    if (!path) return NextResponse.json({ error: '예제 이미지를 찾을 수 없어요.' }, { status: 404, headers });
    const { data, error } = await storageClient().storage.from(PRIVATE_BUCKET).download(path);
    if (error || !data || data.type !== 'image/png') throw new Error('Image unavailable');
    // Proxy only the selected PNG; do not expose keys, storage paths, PDFs or signed URLs.
    return new NextResponse(data, { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Disposition': `inline; filename="page-${value}.png"` } });
  } catch {
    return NextResponse.json({ error: '이미지를 불러오지 못했어요. 다시 시도해주세요.' }, { status: 503, headers });
  }
}
