import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { loadRuntimeEnv } from "../../../src/env.ts";
import { ROOT } from "./runner.ts";
import type { ClientResult, SourceAsset } from "../types.ts";
import { codeAssetId, type CodeFile } from '../../../src/coding.ts';

export const PRIVATE_BUCKET = 'proofolio-private';
export function storageClient() {
  loadRuntimeEnv(ROOT);
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!process.env.SUPABASE_URL || !key) throw new Error('Storage 서버 설정이 필요해요.');
  return createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
export function assetPrefix(userId: string, runId: string) {
  if (!/^[a-f0-9]{64}$/.test(userId) || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('파일 소유권 경로 오류');
  return `${userId}/${runId}/`;
}
export async function uploadAsset(path: string, bytes: Uint8Array, contentType: string) {
  const bucket = storageClient().storage.from(PRIVATE_BUCKET);
  const { error } = await bucket.upload(path, bytes, { contentType, upsert: false });
  if (!error) return;
  // Retries may reuse this run's identical object, but must never overwrite source data.
  const old = await bucket.download(path);
  if (old.error || !old.data || createHash('sha256').update(Buffer.from(await old.data.arrayBuffer())).digest('hex') !== createHash('sha256').update(bytes).digest('hex'))
    throw new Error('비공개 파일 저장에 실패했어요. 원문은 덮어쓰지 않았어요.');
}
export async function storeSources(userId: string, runId: string, pdf: Uint8Array, result: ClientResult, raw: unknown) {
  const prefix = assetPrefix(userId, runId);
  const assets: SourceAsset[] = [{ id: 'pdf', page: 0, kind: 'pdf', path: prefix + 'portfolio.pdf' }];
  await uploadAsset(prefix + 'portfolio.pdf', pdf, 'application/pdf');
  const { openRenderer, renderPage } = await import('../../../src/pdf.ts');
  const document = await openRenderer(pdf);
  try {
    const pages = [...new Set(result.questions.flatMap(q => q.pages))];
    for (const page of pages) {
      const asset: SourceAsset = { id: `page-${page}`, page, kind: 'page', path: `${prefix}page-${page}.png` };
      await uploadAsset(asset.path!, (await renderPage(document, page)).toBuffer('image/png'), 'image/png');
      assets.push(asset);
    }
    for (const q of result.questions) for (const anchor of q.anchors ?? []) {
      if (!anchor.box || assets.some(a => a.id === anchor.assetId)) continue;
      const asset: SourceAsset = { id: anchor.assetId, page: anchor.page, box: anchor.box, kind: 'crop', path: `${prefix}${anchor.assetId}.png` };
      await uploadAsset(asset.path!, (await renderPage(document, asset.page, asset.box)).toBuffer('image/png'), 'image/png');
      assets.push(asset);
    }
  } finally { await document.loadingTask.destroy(); }
  await uploadAsset(prefix + 'analysis.json', Buffer.from(JSON.stringify(raw)), 'application/json');
  return assets;
}
export async function storeCodeSources(userId:string,runId:string,files:CodeFile[],raw:unknown) {
  const prefix=assetPrefix(userId,runId),assets:SourceAsset[]=[];
  for(const file of files){const id=codeAssetId(file.path),path=prefix+id+'.txt';
    await uploadAsset(path,Buffer.from(file.content),'text/plain');assets.push({id,page:0,kind:'code',path});}
  await uploadAsset(prefix+'analysis.json',Buffer.from(JSON.stringify(raw)),'application/json');
  return assets;
}
export async function signedAsset(userId: string, runId: string, path: string | undefined) {
  if (!path || !path.startsWith(assetPrefix(userId, runId)) || path.includes('..')) throw new Error('파일 접근이 허용되지 않아요.');
  const { data, error } = await storageClient().storage.from(PRIVATE_BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw new Error('원문 링크를 만들지 못했어요.');
  return data.signedUrl;
}
