import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as publicImage } from '../web/app/api/examples/[slug]/image/route.ts';
import { GET as publicPortfolio } from '../web/app/api/examples/[slug]/portfolio/route.ts';
import { exampleAnswers, exampleScores } from '../web/lib/server/example-answers.ts';
import type { ClientQuestion } from '../web/lib/types.ts';

test('withdrawn public images and PDFs return 410 without Storage access or signed URLs', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('Public media must not access Storage'); };
    for (const handler of [publicImage, publicPortfolio]) {
      const response = handler();
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('location'), null);
      assert.deepEqual(await response.json(), { error: '이미지 공개 불가' });
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('authored example answers are not reused for another question with the same ID', () => {
  const question: ClientQuestion = { id: 'q1', prompt: '합성 질문', quotes: ['합성 원문'], notes: [], pages: [2],
    projectTitle: '별도 합성 프로젝트', intent: '합성', listenFor: [], answerTarget: '설명' };
  for (const slug of ['design', 'marketing', 'coding', 'unknown']) {
    assert.deepEqual(exampleAnswers(slug, [question]), []);
    assert.equal(exampleScores(slug,[question]),null);
    assert.equal(exampleScores(slug,[]),null);
  }
});
