import { NextResponse } from 'next/server';
import { runUser } from '@/lib/server/access';
import { ownedStatus, AnswerError } from '@/lib/server/runner';
import { signedAsset } from '@/lib/server/assets';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const user = await runUser(request), { runId } = await context.params, run = await ownedStatus(runId, user.id);
    const id = new URL(request.url).searchParams.get('asset');
    const asset = run.result?.sourceAssets?.find(a => a.id === id);
    if (!asset) return NextResponse.json({ error: '원문을 찾을 수 없어요.' }, { status: 404 });
    return NextResponse.json({ url: await signedAsset(user.id, runId, asset.path), kind: asset.kind, box: asset.box, page: asset.page },
      { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) { return NextResponse.json({ error: '원문을 열지 못했어요.' }, { status: e instanceof AnswerError ? e.status : 503 }); }
}
