import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleImagePath, EXAMPLE_LIBRARY_OWNER } from '../web/lib/server/database.ts';
import { exampleAnswers } from '../web/lib/server/example-answers.ts';
import type { ClientQuestion } from '../web/lib/types.ts';

test('public example images only resolve curated, linked pages owned by the example library', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
  const before = keys.map(key => process.env[key]), original = globalThis.fetch;
  const runId = '00000000-0000-4000-8000-000000000001';
  const path = `${EXAMPLE_LIBRARY_OWNER}/${runId}/page-2.png`;
  let owner = EXAMPLE_LIBRARY_OWNER, assetPath = path, kind = 'page', calls = 0;
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
      return Response.json([{ user_id: owner, result: { sourceAssets: [{ id: 'page-2', page: 2, kind, path: assetPath }] } }]);
    };
    for (const [slug, page] of [['coding', 2], ['../design', 2], ['design', 0], ['design', 1.5], ['design', 61]] as const)
      assert.equal(await exampleImagePath(slug, page), null);
    assert.equal(calls, 0);
    assert.equal(await exampleImagePath('design', 2), path);
    assert.equal(await exampleImagePath('design', 3), null);
    owner = 'b'.repeat(64); assert.equal(await exampleImagePath('design', 2), null);
    owner = EXAMPLE_LIBRARY_OWNER; assetPath = path.replace('page-2.png', 'analysis.json');
    assert.equal(await exampleImagePath('design', 2), null);
    assetPath = path; kind = 'pdf'; assert.equal(await exampleImagePath('design', 2), null);
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
