// TEMPORARY: local UI check without an OpenRouter key. Delete this file and the PROOFOLIO_SCORING_MOCK branch before pushing.
import type { Generate } from '../../../src/llm.ts';

export const mockScoringGenerate: Generate = async (request) => {
  const data = JSON.parse(request.prompt.split('\n질문 데이터: ')[1].split('\n답변 데이터: ')[0]) as Array<{ question_id: string; coverage_items: string[] }>;
  const replies = JSON.parse(request.prompt.split('\n답변 데이터: ')[1]) as Array<{ question_id: string; answer: string }>;
  return { items: data.map((q, i) => {
    const answer = replies.find(r => r.question_id === q.question_id)?.answer.trim() ?? '';
    const none = !answer;
    const covered = q.coverage_items.map((_, k) => !none && (i % 3 !== 1 || k === 0));
    return { question_id: q.question_id, relevance: none ? 'none' : covered.every(Boolean) ? 'full' : 'partial',
      coverage: q.coverage_items.map((item, k) => ({ item, covered: covered[k], evidence: covered[k] ? answer.slice(0, 40) : '' })),
      depth: none ? 0 : Math.min(3, Math.floor(answer.length / 60)), logic: none ? 0 : Math.min(4, 1 + (i % 4)), creativity: none ? 0 : i % 3,
      comment: none ? '답변이 없어요.' : '(임시 mock) 답변 길이와 순서로 만든 합성 판정이에요.' };
  }) };
};
