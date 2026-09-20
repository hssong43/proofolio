import { NextResponse } from 'next/server';
import { example } from '@/lib/server/database';
import { contestSettings } from '@/lib/server/contest';
import { exampleAnswers, exampleScores } from '@/lib/server/example-answers';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const contest=contestSettings();
  if(contest.enabled&&contest.closed)return NextResponse.json({error:'프리뷰가 종료됐어요.'},{status:410,headers:{'Cache-Control':'no-store'}});
  try {
    const item = await example((await context.params).slug);
    // Only curated examples are public; storage paths and visitor data stay out of this response.
    const { sourceAssets: _assets, ...result } = item.result;
    const images = [...new Set(result.questions.flatMap(q => q.pages))].sort((a,b) => a-b)
      .map(page => ({ page, url: `/api/examples/${item.slug}/image?page=${page}` }));
    const portfolioUrl = item.slug === 'coding' ? null : `/api/examples/${item.slug}/portfolio`;
    return NextResponse.json({ title: item.title, notice: item.notice, result, images, portfolioUrl,
      sampleAnswers: exampleAnswers(item.slug, result.questions), sampleScores: exampleScores(item.slug, result.questions) },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const configurationError = error instanceof Error && error.message === 'Supabase URL과 서버 전용 키를 설정해주세요.';
    return NextResponse.json({
      error: configurationError ? '예제 서버 연결 설정이 필요해요. 운영자가 배포 환경의 Supabase 설정을 확인해야 해요.' : '저장된 예제를 불러오지 못했어요. 잠시 후 다시 시도해주세요.',
      code: configurationError ? 'EXAMPLE_CONFIGURATION_ERROR' : 'EXAMPLE_LOAD_FAILED',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
