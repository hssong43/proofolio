import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_MAX_QUESTIONS, MIN_TARGET_QUESTIONS, MAX_PDF_BYTES } from '../../../src/constants.ts';
import { admitRun, AnswerError, ownedStatus, startRun } from './runner.ts';
import { dbRequest, storageMode, syncRun, type StoredRun } from './database.ts';
import { assetPrefix, PRIVATE_BUCKET, signedAsset, storageClient } from './assets.ts';
import type { runUser } from './access.ts';

type UploadUser = Awaited<ReturnType<typeof runUser>>;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// The advertised length is not trusted; also cap the bytes actually read.
export async function boundedBody(source: Request | Response, limit: number) {
  if (Number(source.headers.get('content-length')) > limit) throw new AnswerError('파일 또는 요청이 너무 커요.', 413);
  const reader = source.body?.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new AnswerError('파일 또는 요청이 너무 커요.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function uploadJson(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AnswerError('JSON 요청이 필요해요.', 400);
  const bytes = await boundedBody(request, 4096);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new AnswerError('요청 형식을 확인해주세요.', 400); }
}

export function uploadMetadata(value: unknown) {
  const b = value as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b) ||
    typeof b.fileName !== 'string' || !b.fileName.trim() || b.fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(b.fileName) ||
    !Number.isSafeInteger(b.size) || (b.size as number) < 5 || (b.size as number) > MAX_PDF_BYTES ||
    typeof b.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.sha256) ||
    !['design', 'marketing'].includes(b.track as string)) throw new AnswerError('50MB 이하 PDF의 파일 정보를 확인해주세요.', 400);
  const maxQuestions = b.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  if (!Number.isInteger(maxQuestions) || (maxQuestions as number) < MIN_TARGET_QUESTIONS || (maxQuestions as number) > DEFAULT_MAX_QUESTIONS)
    throw new AnswerError('질문 수는 6~10개예요.', 400);
  if (b.submissionId !== undefined && (typeof b.submissionId !== 'string' || !RUN_ID.test(b.submissionId)))
    throw new AnswerError('응시 정보를 확인해주세요.', 400);
  return { fileName: b.fileName, size: b.size as number, sha256: b.sha256, track: b.track as 'design' | 'marketing',
    maxQuestions: maxQuestions as number, submissionId: b.submissionId as string | undefined };
}

export async function preparePdfUpload(metadata: ReturnType<typeof uploadMetadata>, user: UploadUser) {
  if (storageMode() !== 'supabase') throw new AnswerError('직접 업로드에는 비공개 Storage 연결이 필요해요.', 503);
  const status: StoredRun = { runId: randomUUID(), userId: user.id, fileName: metadata.fileName, track: metadata.track,
    pdfSha256: metadata.sha256, requestedQuestions: metadata.maxQuestions, state: 'running', stage: 0,
    startedAt: new Date().toISOString(), storage: 'supabase' };
  // Admission creates the retention/ownership record BEFORE a signed upload is issued.
  await admitRun(status, user);
  try {
    status.state = 'queued';
    await syncRun(status);
    const { data, error } = await storageClient().storage.from(PRIVATE_BUCKET)
      .createSignedUploadUrl(assetPrefix(user.id, status.runId) + 'portfolio.pdf', { upsert: false });
    if (error || !data) throw new AnswerError('PDF 업로드 주소를 만들지 못했어요.', 503);
    return { runId: status.runId, uploadUrl: data.signedUrl };
  } catch (e) {
    status.state = 'failed'; status.error = 'PDF 업로드 준비에 실패했어요.'; status.finishedAt = new Date().toISOString();
    await syncRun(status).catch(() => {});
    throw e;
  }
}

async function uploadedRun(runId: unknown, user: UploadUser) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new AnswerError('업로드 ID를 확인해주세요.', 400);
  const run = await ownedStatus(runId, user.id);
  if (run.storage !== 'supabase' || !['design', 'marketing'].includes(run.track)) throw new AnswerError('PDF 업로드를 찾을 수 없어요.', 404);
  return run;
}

export function verifyUploadedPdf(bytes: Uint8Array, expectedHash: string | undefined) {
  if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES || Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-')
    throw new AnswerError('50MB 이하 PDF 파일만 올릴 수 있어요.', 400);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new AnswerError('선택한 파일과 업로드한 파일이 달라요. 분석하지 않았어요.', 400);
}

export async function finishPdfUpload(runId: unknown, user: UploadUser) {
  const run = await uploadedRun(runId, user);
  if (run.state === 'failed') throw new AnswerError(run.error ?? '종료된 업로드예요.', 409);
  if (run.state !== 'queued') return { runId: run.runId }; // Same-ID retries never start another paid run.
  const path = assetPrefix(user.id, run.runId) + 'portfolio.pdf';
  const response = await fetch(await signedAsset(user.id, run.runId, path), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new AnswerError('PDF 업로드가 완료되지 않았어요.', 409);
  const bytes = await boundedBody(response, MAX_PDF_BYTES);
  verifyUploadedPdf(bytes, run.pdfSha256);
  // Compare-and-set is in Postgres, not an in-memory lock in a Vercel instance.
  const claimed = await dbRequest(`/rest/v1/proofolio_runs?id=eq.${run.runId}&user_id=eq.${user.id}&state=eq.queued&deleted_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ state: 'running' }),
  });
  if (!claimed?.length) return { runId: run.runId };
  run.state = 'running';
  try {
    await startRun({ bytes, fileName: run.fileName, track: run.track, maxQuestions: run.requestedQuestions,
      userId: user.id, member: user.member, guestExpiresAt: user.guestExpiresAt, preparedRun: run });
  } catch (e) {
    // Only change this pending run. Completed results and an already saved failure stay immutable.
    await dbRequest(`/rest/v1/proofolio_runs?id=eq.${run.runId}&user_id=eq.${user.id}&state=eq.running`, {
      method: 'PATCH', body: JSON.stringify({ state: 'failed', finished_at: new Date().toISOString(),
        error: e instanceof AnswerError ? e.message : 'PDF는 업로드됐지만 분석을 시작하지 못했어요.' }),
    });
    throw e;
  }
  return { runId: run.runId };
}

export async function cancelPdfUpload(runId: unknown, user: UploadUser) {
  const run = await uploadedRun(runId, user);
  // Keep the object tracked until retention; its two-hour upload token may still be live.
  await dbRequest(`/rest/v1/proofolio_runs?id=eq.${run.runId}&user_id=eq.${user.id}&state=eq.queued`, {
    method: 'PATCH', body: JSON.stringify({ state: 'failed', finished_at: new Date().toISOString(), error: 'PDF 업로드가 취소됐어요.' }),
  });
}
