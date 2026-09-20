import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleAssetPath, EXAMPLE_LIBRARY_OWNER } from '../web/lib/server/database.ts';
import { exampleAnswers } from '../web/lib/server/example-answers.ts';
import type { ClientQuestion } from '../web/lib/types.ts';

test('public examples only resolve curated PDFs and linked images owned by the matching example library', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
  const before = keys.map(key => process.env[key]), original = globalThis.fetch;
  const runId = '00000000-0000-4000-8000-000000000001';
  const path = `${EXAMPLE_LIBRARY_OWNER}/${runId}/page-2.png`;
  const pdfPath = `${EXAMPLE_LIBRARY_OWNER}/${runId}/portfolio.pdf`;
  const pdfAsset = { id: 'pdf', page: 0, kind: 'pdf', path: pdfPath };
  let owner = EXAMPLE_LIBRARY_OWNER, track = 'design', assetPath = path, kind = 'page', calls = 0;
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_synthetic';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(init?.method, undefined);
      const url = new URL(String(input));
      if (url.pathname === '/rest/v1/proofolio_examples') return Response.json([{
        slug: 'design', source_run_id: runId, result: { questions: [{ pages: [2] }] },
      }]);
      assert.equal(url.pathname, '/rest/v1/proofolio_runs');
      assert.equal(url.searchParams.get('id'), `eq.${runId}`);
      assert.equal(url.searchParams.get('deleted_at'), 'is.null');
      assert.equal(url.searchParams.get('state'), 'eq.complete');
      return Response.json([{ user_id: owner, track, result: { sourceAssets: [{ id: 'page-2', page: 2, kind, path: assetPath }, pdfAsset] } }]);
    };
    for (const [slug, page] of [['coding', 2], ['coding', 'pdf'], ['../design', 2], ['../design', 'pdf'], ['design', 0], ['design', 1.5], ['design', 61]] as const)
      assert.equal(await exampleAssetPath(slug, page), null);
    assert.equal(calls, 0);
    assert.equal(await exampleAssetPath('design', 2), path);
    assert.equal(await exampleAssetPath('design', 3), null);
    assert.equal(await exampleAssetPath('design', 'pdf'), pdfPath);
    owner = 'b'.repeat(64);
    assert.equal(await exampleAssetPath('design', 2), null);
    assert.equal(await exampleAssetPath('design', 'pdf'), null);
    owner = EXAMPLE_LIBRARY_OWNER; assetPath = path.replace('page-2.png', 'analysis.json');
    assert.equal(await exampleAssetPath('design', 2), null);
    assetPath = path; kind = 'pdf'; assert.equal(await exampleAssetPath('design', 2), null);
    kind = 'page'; track = 'marketing';
    assert.equal(await exampleAssetPath('design', 2), null);
    assert.equal(await exampleAssetPath('design', 'pdf'), null);
    track = 'design'; pdfAsset.path = pdfPath.replace('portfolio.pdf', 'analysis.json');
    assert.equal(await exampleAssetPath('design', 'pdf'), null);
    pdfAsset.path = pdfPath; pdfAsset.kind = 'page';
    assert.equal(await exampleAssetPath('design', 'pdf'), null);
    pdfAsset.kind = 'pdf'; pdfAsset.id = 'unregistered';
    assert.equal(await exampleAssetPath('design', 'pdf'), null);
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
  }
});

test('authored example answers are not reused for another question with the same ID', () => {
  const question: ClientQuestion = { id: 'q1', prompt: '합성 질문', quotes: ['합성 원문'], notes: [], pages: [2],
    projectTitle: '별도 합성 프로젝트', intent: '합성', listenFor: [], answerTarget: '설명' };
  for (const slug of ['design', 'marketing', 'coding', 'unknown']) assert.deepEqual(exampleAnswers(slug, [question]), []);
});
