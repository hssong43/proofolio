import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startAnalysis } from '../web/lib/client.ts';
import { boundedBody, cancelPdfUpload, finishPdfUpload, preparePdfUpload, uploadMetadata, verifyUploadedPdf } from '../web/lib/server/upload.ts';

// All fetches below are synthetic. Never inherit live keys or execute the paid CLI.
process.env.PROOFOLIO_STORAGE = 'supabase';
process.env.SUPABASE_URL = 'https://synthetic.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_synthetic';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.PROOFOLIO_MAX_COST_USD = '0';
const owner = 'a'.repeat(64), runId = randomUUID();
const user = { id: owner, member: false as const, guestExpiresAt: new Date(Date.now() + 86400000).toISOString() };
const bytes = Buffer.from('%PDF-1.7\nSYNTHETIC');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const metadata = { fileName: 'synthetic.pdf', size: bytes.length, track: 'design', maxQuestions: 10, sha256 };

test('5MB+ PDF goes directly to Storage; Vercel receives only metadata and run ID', async () => {
  const original = globalThis.fetch, calls: string[] = [];
  const file = new File([bytes, new Uint8Array(5_100_000)], 'large.pdf', { type: 'application/pdf' });
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url === '/api/analyze/upload') {
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(init!.body as string);
      assert.equal(body.size, file.size); assert.equal(body.maxQuestions, 10); assert.equal(body.track, 'design');
      assert.match(body.sha256, /^[a-f0-9]{64}$/); assert.ok((init!.body as string).length < 4096);
      return Response.json({ runId, uploadUrl: 'https://storage.example/signed-object' });
    }
    if (url === 'https://storage.example/signed-object') {
      assert.equal(init?.body, file); assert.equal(init.method, 'PUT'); assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('authorization'), null);
      return Response.json({ Key: 'synthetic' });
    }
    assert.equal(url, '/api/analyze');
    assert.deepEqual(JSON.parse(init!.body as string), { runId });
    return Response.json({ runId });
  };
  try {
    assert.deepEqual(await startAnalysis(file, 'design', 10), { runId });
    assert.deepEqual(calls, ['/api/analyze/upload', 'https://storage.example/signed-object', '/api/analyze']);
  } finally { globalThis.fetch = original; }
});

test('upload boundaries reject forged metadata, oversized streams, non-PDF bytes and changed hashes', async () => {
  assert.equal(uploadMetadata(metadata).maxQuestions, 10);
  for (const changes of [{ fileName: '../bad.pdf' }, { size: 50_000_001 }, { sha256: 'bad' }, { maxQuestions: 11 }, { track: 'coding' }])
    assert.throws(() => uploadMetadata({ ...metadata, ...changes }));
  verifyUploadedPdf(bytes, sha256);
  assert.throws(() => verifyUploadedPdf(Buffer.from('not PDF'), sha256));
  assert.throws(() => verifyUploadedPdf(bytes, 'b'.repeat(64)));
  await assert.rejects(boundedBody(new Response('123456', { headers: { 'content-length': '2' } }), 5), /너무 커요/);
});

test('quota rejection happens before creating an upload capability or storing any PDF', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++; assert.ok(String(input).endsWith('/rpc/proofolio_start_guest_run'));
    return Response.json({}, { status: 429 });
  };
  try { await assert.rejects(preparePdfUpload(uploadMetadata(metadata), user), /24시간/); assert.equal(calls, 1); }
  finally { globalThis.fetch = original; }
});

test('step upload reports disabled budget separately and never admits an upload', async () => {
  const original=globalThis.fetch,keys=['VERCEL','PROOFOLIO_MAX_COST_USD'] as const,before=keys.map(k=>process.env[k]);
  let calls=0;
  process.env.VERCEL='1';
  globalThis.fetch=async(input)=>{
    calls++;assert.match(String(input),/proofolio_execution_budget\?/);
    return Response.json([{limit_usd:10,spent_usd:0,reserved_usd:0,blocked:true,legacy_sha256:'a'.repeat(64)}]);
  };
  try {
    process.env.PROOFOLIO_MAX_COST_USD='0';
    await assert.rejects(preparePdfUpload(uploadMetadata(metadata),user),/일시 중지/);assert.equal(calls,0);
    process.env.PROOFOLIO_MAX_COST_USD='10';
    await assert.rejects(preparePdfUpload(uploadMetadata(metadata),user),/예산을 다시 승인/);assert.equal(calls,1);
    globalThis.fetch=async()=>Response.json({}, {status:503});
    await assert.rejects(preparePdfUpload(uploadMetadata(metadata),user),/분석 예산 DB/);
  } finally {globalThis.fetch=original;keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];});}
});

test('foreign owner is rejected; same-ID concurrent finish cannot launch twice; zero budget blocks Vercel model calls', async () => {
  const original = globalThis.fetch, previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  let state = 'queued', claims = 0, failures = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/proofolio_runs' && (!init?.method || init.method === 'GET'))
      return Response.json([{ id: runId, user_id: owner, track: 'design', file_name: 'synthetic.pdf', pdf_sha256: sha256,
        state, started_at: new Date().toISOString(), requested_question_count: 10 }]);
    if (url.pathname.startsWith('/storage/v1/object/sign/') && init?.method === 'POST')
      return Response.json({ signedURL: `/object/sign/proofolio-private/${owner}/${runId}/portfolio.pdf?token=synthetic` });
    if (url.pathname.startsWith('/storage/v1/object/sign/') && !init?.method) return new Response(bytes);
    assert.equal(url.pathname, '/rest/v1/proofolio_runs'); assert.equal(init?.method, 'PATCH');
    assert.equal(url.searchParams.get('user_id'), `eq.${owner}`);
    const body = JSON.parse(init!.body as string);
    if (body.state === 'running') {
      claims++; assert.equal(url.searchParams.get('state'), 'eq.queued');
      if (state !== 'queued') return Response.json([]);
      state = 'running'; return Response.json([{ id: runId }]);
    }
    failures++; state = 'failed'; return new Response(null, { status: 204 });
  };
  try {
    await assert.rejects(finishPdfUpload(runId, { ...user, id: 'b'.repeat(64) }), /찾을 수/);
    assert.equal(claims, 0);
    const results = await Promise.allSettled([finishPdfUpload(runId, user), finishPdfUpload(runId, user)]);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal(failures, 1); assert.equal(state, 'failed'); assert.ok(claims >= 1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.match(failed.reason.message, /승인한 누적 한도/);
  } finally { globalThis.fetch = original; if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel; }
});

test('failed PUT cancels only the pending run, never retries upload or starts analysis', async () => {
  const original = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method} ${input}`);
    if (String(input) === '/api/analyze/upload' && init?.method === 'POST') return Response.json({ runId, uploadUrl: 'https://storage.example/signed-object' });
    if (init?.method === 'PUT') return Response.json({}, { status: 503 });
    assert.equal(init?.method, 'DELETE'); assert.equal(String(input), '/api/analyze/upload');
    return Response.json({ ok: true });
  };
  try {
    await assert.rejects(startAnalysis(new File([bytes], 'test.pdf'), 'design', 10), /업로드에 실패/);
    assert.deepEqual(calls, ['POST /api/analyze/upload', 'PUT https://storage.example/signed-object', 'DELETE /api/analyze/upload']);
  } finally { globalThis.fetch = original; }
});

test('cancel is conditional on queued state and retains a record for file cleanup', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/rest/v1/proofolio_runs');
    if (init?.method === 'PATCH') {
      assert.equal(url.searchParams.get('state'), 'eq.queued');
      assert.equal(JSON.parse(init.body as string).state, 'failed');
      return new Response(null, { status: 204 });
    }
    return Response.json([{ id: runId, user_id: owner, track: 'design', state: 'running', started_at: new Date().toISOString() }]);
  };
  try { await cancelPdfUpload(runId, user); }
  finally { globalThis.fetch = original; }
});
