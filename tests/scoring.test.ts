import test from 'node:test';
import assert from 'node:assert/strict';
import {freshMetrics,SchemaValidationError} from '../src/llm.ts';
import {modelRequest} from '../src/questions.ts';
import {OPENROUTER_MODELS,buildOpenRouterPayload} from '../src/openrouter.ts';
import {AnswerScoring,SCORING_KIND,checkJudgments,computeScore,coverageItems,scoreAnswers,scoringPrompt} from '../src/scoring.ts';
import type {ScoringJudgment,ScoringQuestion} from '../src/scoring.ts';

const questions:ScoringQuestion[]=[
  {id:'q1',prompt:'표기하신 기여 범위는 구체적으로 어떤 작업들을 포함하나요?',intent:'문서에 적힌 기여 표기가 실제로 어떤 작업 범위를 가리키는지 확인한다.',listenFor:['직접 수행한 작업의 구체적 범위','협업자와 나눈 역할']},
  {id:'q2',prompt:'이탈률 개선의 측정 조건은 무엇이었나요?',intent:'수치의 측정 조건 확인',listenFor:['기간과 비교 기준']},
];
const judgment=(over:Partial<ScoringJudgment>&{question_id:string;coverage:ScoringJudgment['coverage']}):ScoringJudgment=>
  ({relevance:'full',depth:3,logic:4,creativity:3,comment:'모든 항목을 근거와 함께 설명했어요.',...over});
const cov=(q:ScoringQuestion,flags:boolean[])=>coverageItems(q).map((item,i)=>({item,covered:flags[i],evidence:flags[i]?'근거 구절':''}));

test('coverage items are intent first, then listen_for, and the score follows the 80/60/100 rule',()=>{
  assert.deepEqual(coverageItems(questions[0]),['문서에 적힌 기여 표기가 실제로 어떤 작업 범위를 가리키는지 확인한다.','직접 수행한 작업의 구체적 범위','협업자와 나눈 역할']);
  const all=cov(questions[0],[true,true,true]);
  assert.deepEqual(computeScore({relevance:'full',coverage:all,depth:0,logic:0,creativity:0}),{score:80,coverageScore:80,bonus:0,missing:[]});
  assert.equal(computeScore({relevance:'full',coverage:all,depth:3,logic:4,creativity:3}).score,100);
  assert.equal(computeScore({relevance:'full',coverage:all,depth:1,logic:2,creativity:1}).bonus,8);
  const oneMissing=computeScore({relevance:'partial',coverage:cov(questions[0],[true,true,false]),depth:3,logic:4,creativity:3});
  assert.equal(oneMissing.score,73);assert.equal(oneMissing.bonus,0); // 누락이 있으면 가산 없음assert.deepEqual(oneMissing.missing,['협업자와 나눈 역할']);
  const twoMissing=computeScore({relevance:'partial',coverage:cov(questions[0],[true,false,false]),depth:0,logic:0,creativity:0});
  assert.equal(twoMissing.score,67);
  // 답변이 있으면 항목을 전혀 다루지 못해도 60점 하한, 등급으로 최대 80까지
  assert.equal(computeScore({relevance:'partial',coverage:cov(questions[0],[false,false,false]),depth:0,logic:0,creativity:0}).score,60);
  assert.equal(computeScore({relevance:'none',coverage:cov(questions[0],[false,false,false]),depth:0,logic:0,creativity:0}).score,60);
  assert.equal(computeScore({relevance:'partial',coverage:cov(questions[0],[false,false,false]),depth:3,logic:4,creativity:3}).score,60);
  // 빈 답변만 0점 (코드가 원문으로 판단)
  assert.equal(computeScore({relevance:'none',coverage:cov(questions[0],[false,false,false]),depth:3,logic:4,creativity:3},false).score,0);
});

test('judgment check enforces order, coverage items and relevance consistency',()=>{
  const ok=[judgment({question_id:'q1',coverage:cov(questions[0],[true,true,true])}),judgment({question_id:'q2',coverage:cov(questions[1],[true,true])})];
  checkJudgments(questions,ok);
  assert.throws(()=>checkJudgments(questions,[ok[0]]),/개수/);
  assert.throws(()=>checkJudgments(questions,[ok[1],ok[0]]),/question_id/);
  assert.throws(()=>checkJudgments(questions,[{...ok[0],coverage:ok[0].coverage.slice(1)},ok[1]]),/coverage/);
  assert.throws(()=>checkJudgments(questions,[{...ok[0],coverage:[{...ok[0].coverage[0],item:'다른 문구'},...ok[0].coverage.slice(1)]},ok[1]]),/coverage/);
  assert.throws(()=>checkJudgments(questions,[{...ok[0],relevance:'none'},ok[1]]),/relevance=none/);
  assert.throws(()=>checkJudgments(questions,[{...ok[0],relevance:'full',coverage:cov(questions[0],[true,false,true])},ok[1]]),/relevance=full/);
  assert.throws(()=>checkJudgments(questions,[{...ok[0],relevance:'partial',coverage:[{item:ok[0].coverage[0].item,covered:false,evidence:'x'},...ok[0].coverage.slice(1)]},ok[1]]),/evidence/);
});

test('scoreAnswers builds the prompt from cards, skips the model for empty answers, retries once on mismatch',async()=>{
  const stats=freshMetrics(),prompts:string[]=[];
  const empty=await scoreAnswers({questions,answers:[{questionId:'q1',answer:'   '}]},async()=>{throw new Error('should not call');});
  assert.equal(empty.overallScore,0);assert.deepEqual(empty.items.map(i=>[i.questionId,i.score,i.relevance]),[['q1',0,'none'],['q2',0,'none']]);
  const good={items:[judgment({question_id:'q1',coverage:cov(questions[0],[true,true,false]),relevance:'partial',depth:2,logic:2,creativity:1}),
    judgment({question_id:'q2',coverage:cov(questions[1],[false,false]),relevance:'none',depth:0,logic:0,creativity:0,comment:'답변이 없어요.'})]};
  const generate=async(req:{kind:string;prompt:string;model:string;thinkingLevel?:string})=>{prompts.push(req.prompt);
    assert.equal(req.kind,SCORING_KIND);assert.equal(req.model,'scoring-fixture');assert.equal(req.thinkingLevel,'MEDIUM');
    return prompts.length===1?{items:[good.items[1],good.items[0]]}:good;};
  const request=modelRequest(generate as any,stats,{model:'base',scoringModel:'scoring-fixture'});
  const result=await scoreAnswers({questions,answers:[{questionId:'q1',answer:'디자인 시스템 컴포넌트 12개를 직접 설계했고 이유는 일관성 때문입니다.'}]},request);
  assert.equal(prompts.length,2);assert.match(prompts[1],/question_id/);
  assert.match(prompts[0],/질문 데이터: \[\{"question_id":"q1"/);assert.match(prompts[0],/답변 데이터: /);assert.match(prompts[0],/coverage_items/);
  assert.match(prompts[0],/점수를 직접 매기지 않고/);assert.match(prompts[0],/합격 여부/);
  assert.equal(result.items[0].score,73);assert.equal(result.items[0].bonus,0);assert.deepEqual(result.items[0].missing,['협업자와 나눈 역할']);
  assert.equal(result.items[1].score,0);assert.equal(result.overallScore,Math.round((73+0)/2));
  await assert.rejects(scoreAnswers({questions,answers:[{questionId:'q1',answer:'a'}]},modelRequest(async()=>({items:[]}),freshMetrics(),{model:'x'})),SchemaValidationError);
  assert.deepEqual(AnswerScoring.safeParse(good).success,true);
  assert.equal(scoringPrompt(questions,[{questionId:'q1',answer:'x'.repeat(600)}]).includes('x'.repeat(501)),false);
});

test('Opus accepts the text-only AnswerScoring kind and still rejects other kinds and attachments',()=>{
  const base={model:OPENROUTER_MODELS.questions,prompt:'채점',schema:AnswerScoring};
  const payload=buildOpenRouterPayload({...base,kind:SCORING_KIND,maxOutputTokens:8192});
  assert.equal(payload.max_tokens,8192);assert.equal(payload.response_format.type,'json_object');
  assert.throws(()=>buildOpenRouterPayload({...base,kind:'Reviews'}),/Opus/);
  assert.throws(()=>buildOpenRouterPayload({...base,kind:SCORING_KIND,images:[['x',Buffer.alloc(8)]]}),/Opus/);
});
