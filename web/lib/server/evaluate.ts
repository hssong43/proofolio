import type { AnswerRecord, Evaluation, EvaluationItem, UiQuestion } from "../types.ts";

/**
 * 규칙 기반 mock 평가. 결정적이며 외부 호출이 없다.
 * 나중에 LLM 평가로 바꿀 때 이 함수의 시그니처만 유지하면 된다.
 */
const SIGNALS: Array<{ key: string; label: string; re: RegExp; points: number }> = [
  { key: "numbers", label: "구체적인 수치", re: /\p{N}/u, points: 10 },
  { key: "reasoning", label: "판단 기준", re: /이유|근거|때문|기준|판단/, points: 10 },
  { key: "outcome", label: "결과와 측정", re: /결과|지표|측정|개선|효과|검증/, points: 10 },
  { key: "alternatives", label: "대안 비교", re: /대안|비교|트레이드오프|대신|선택지/, points: 10 },
  { key: "ownership", label: "직접 수행 범위", re: /직접|제가|담당|맡/, points: 5 },
];
const MISSING_HINTS: Record<string, string> = {
  numbers: "수치나 기간을 덧붙이면 더 좋아요",
  reasoning: "판단 기준을 설명하면 더 좋아요",
  outcome: "결과를 어떻게 확인했는지 덧붙이면 더 좋아요",
  alternatives: "검토한 대안을 언급하면 더 좋아요",
  ownership: "직접 맡은 범위를 구분해 주면 더 좋아요",
};

export function scoreAnswer(answer: string): { score: number; comment: string; signals: string[] } {
  const text = answer.trim();
  if (!text) return { score: 0, comment: "답변이 없어요.", signals: [] };
  let score = 30 + Math.min(25, Math.floor(text.length / 40) * 5);
  const found = SIGNALS.filter((s) => s.re.test(text));
  for (const s of found) score += s.points;
  const sentences = text.split(/[.!?。\n]+/).filter((s) => s.trim().length > 0).length;
  if (sentences >= 2) score += 5;
  score = Math.min(100, score);
  const strengths = found.map((s) => s.label);
  const missing = SIGNALS.filter((s) => !found.includes(s)).slice(0, 2).map((s) => MISSING_HINTS[s.key]);
  const first = strengths.length ? `${strengths.join(", ")}이(가) 드러나요.` : "일반적인 설명에 머물러 있어요.";
  const second = missing.length ? `${missing[0]}.` : "근거가 충분히 구체적이에요.";
  return { score, comment: `${first} ${second}`, signals: found.map((s) => s.key) };
}

export function evaluateSubmission(input: { questions: UiQuestion[]; answers: AnswerRecord[]; passScore: number }, now = new Date()): Evaluation {
  const byId = new Map(input.answers.map((a) => [a.questionId, a]));
  const items: EvaluationItem[] = input.questions.map((q) => ({ questionId: q.id, ...scoreAnswer(byId.get(q.id)?.answer ?? "") }));
  const overallScore = items.length ? Math.round(items.reduce((sum, i) => sum + i.score, 0) / items.length) : 0;
  return { method: "mock-rules", version: 1, passScore: input.passScore, overallScore, passed: overallScore >= input.passScore, items, evaluatedAt: now.toISOString() };
}
