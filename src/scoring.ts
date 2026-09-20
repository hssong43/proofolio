import * as z from 'zod';
import type {Request} from './questions.ts';
import {SCORING_PROMPT} from './prompts.ts';
import {ANSWER_MAX_LENGTH,SCORING_BASELINE,SCORING_BONUS_MAX,SCORING_FLOOR,SCORING_MAX_OUTPUT_TOKENS} from './constants.ts';

export const SCORING_KIND='AnswerScoring';
export const DEPTH_MAX=3,LOGIC_MAX=4,CREATIVITY_MAX=3;

export const AnswerScoring=z.strictObject({items:z.array(z.strictObject({
  question_id:z.string().min(1).max(64),
  relevance:z.enum(['none','partial','full']),
  coverage:z.array(z.strictObject({item:z.string().min(1).max(400),covered:z.boolean(),evidence:z.string().max(120)})).max(8),
  depth:z.number().int().min(0).max(DEPTH_MAX),
  logic:z.number().int().min(0).max(LOGIC_MAX),
  creativity:z.number().int().min(0).max(CREATIVITY_MAX),
  comment:z.string().max(400),
})).max(20)});
export type ScoringJudgment=z.infer<typeof AnswerScoring>['items'][number];

export type ScoringQuestion={id:string;prompt:string;intent:string;listenFor:string[]};
export type ScoringAnswer={questionId:string;answer:string};
export type ScoreItem={questionId:string;score:number;coverageScore:number;bonus:number;relevance:ScoringJudgment['relevance'];
  coverage:ScoringJudgment['coverage'];missing:string[];depth:number;logic:number;creativity:number;comment:string};
export type ScoringResult={items:ScoreItem[];overallScore:number};

/** 첫 항목은 질문 의도, 나머지는 확인 사항. 모델은 이 배열을 그대로 돌려줘야 한다. */
export function coverageItems(q:{intent:string;listenFor:string[]}):string[] {
  return [q.intent,...q.listenFor].map(s=>s.trim()).filter(Boolean);
}

/**
 * 규칙: 의도와 확인 사항을 모두 다루면 80점 기준. 누락은 비례 감점하되 60점 아래로 내려가지 않는다.
 * 분량·논리·창의성 등급으로 최대 20점을 더해 100점까지. 무관한/빈 답변은 0점.
 * 모델은 등급과 포함 여부만 내고 점수는 여기서만 계산한다.
 */
export function computeScore(j:Pick<ScoringJudgment,'relevance'|'coverage'|'depth'|'logic'|'creativity'>) {
  const missing=j.coverage.filter(c=>!c.covered).map(c=>c.item);
  if(j.relevance==='none'||(j.coverage.length&&missing.length===j.coverage.length&&j.depth===0))
    return {score:0,coverageScore:0,bonus:0,missing};
  const total=Math.max(1,j.coverage.length);
  const coverageScore=Math.max(SCORING_FLOOR,SCORING_BASELINE-(SCORING_BASELINE-SCORING_FLOOR)*missing.length/total);
  const bonus=Math.min(SCORING_BONUS_MAX,Math.round(SCORING_BONUS_MAX*(j.depth+j.logic+j.creativity)/(DEPTH_MAX+LOGIC_MAX+CREATIVITY_MAX)));
  return {score:Math.min(100,Math.round(coverageScore+bonus)),coverageScore:Math.round(coverageScore),bonus,missing};
}

export function scoringPrompt(questions:ScoringQuestion[],answers:ScoringAnswer[]) {
  const byId=new Map(answers.map(a=>[a.questionId,a.answer.slice(0,ANSWER_MAX_LENGTH)]));
  const data=questions.map(q=>({question_id:q.id,question:q.prompt,intent:q.intent,listen_for:q.listenFor,coverage_items:coverageItems(q)}));
  const replies=questions.map(q=>({question_id:q.id,answer:byId.get(q.id)??''}));
  return SCORING_PROMPT+'\n질문 데이터: '+JSON.stringify(data)+'\n답변 데이터: '+JSON.stringify(replies);
}

/** 판정이 질문 집합·coverage 항목과 정확히 맞는지 검사한다. 어긋나면 형식 오류로 1회 재요청된다. */
export function checkJudgments(questions:ScoringQuestion[],items:ScoringJudgment[]) {
  if(items.length!==questions.length)throw new Error('items 개수가 질문 수와 다릅니다.');
  questions.forEach((q,i)=>{const item=items[i];
    if(item.question_id!==q.id)throw new Error(`items.${i}.question_id는 ${q.id}여야 합니다.`);
    const expected=coverageItems(q);
    if(item.coverage.length!==expected.length||item.coverage.some((c,k)=>c.item!==expected[k]))
      throw new Error(`items.${i}.coverage는 coverage_items와 같은 순서·문구여야 합니다.`);
    if(item.relevance==='none'&&item.coverage.some(c=>c.covered))throw new Error(`items.${i}: relevance=none이면 covered는 모두 false여야 합니다.`);
    if(item.relevance==='full'&&item.coverage.some(c=>!c.covered))throw new Error(`items.${i}: relevance=full이면 covered는 모두 true여야 합니다.`);
    if(item.coverage.some(c=>!c.covered&&c.evidence))throw new Error(`items.${i}: covered=false이면 evidence는 비어야 합니다.`);
  });
}

export async function scoreAnswers(input:{questions:ScoringQuestion[];answers:ScoringAnswer[]},request:Request):Promise<ScoringResult> {
  const questions=input.questions.filter(q=>q.id&&q.prompt);
  if(!questions.length)return {items:[],overallScore:0};
  const answered=input.answers.filter(a=>a.answer.trim());
  // 답변이 하나도 없으면 모델을 부르지 않는다.
  const empty:ScoreItem[]=questions.map(q=>({questionId:q.id,score:0,coverageScore:0,bonus:0,relevance:'none',
    coverage:coverageItems(q).map(item=>({item,covered:false,evidence:''})),missing:coverageItems(q),depth:0,logic:0,creativity:0,comment:'답변이 없어요.'}));
  if(!answered.length)return {items:empty,overallScore:0};
  const parsed=await request(SCORING_KIND,AnswerScoring,{prompt:scoringPrompt(questions,input.answers),maxOutputTokens:SCORING_MAX_OUTPUT_TOKENS},
    data=>checkJudgments(questions,data.items));
  const items:ScoreItem[]=parsed.items.map(j=>{const computed=computeScore(j);
    return {questionId:j.question_id,...computed,relevance:j.relevance,coverage:j.coverage,depth:j.depth,logic:j.logic,creativity:j.creativity,comment:j.comment};});
  const overallScore=Math.round(items.reduce((sum,i)=>sum+i.score,0)/items.length);
  return {items,overallScore};
}
