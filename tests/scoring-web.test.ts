import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {scoreSubmission,scoresFor,scoringModel,toScore} from '../web/lib/server/scoring.ts';
import {listSubmissions,rescoreSubmission} from '../web/lib/server/recruiting.ts';
import {AnswerScoring} from '../src/scoring.ts';

const owner='a'.repeat(64),candidate='b'.repeat(64),other='c'.repeat(64);
const testId=randomUUID(),submissionId=randomUUID(),runId=randomUUID();
const questions=[{id:'q1',prompt:'기여 범위는?',quotes:[],notes:[],pages:[1],projectTitle:'p',intent:'기여 범위 확인',listenFor:['직접 수행 범위'],answerTarget:'x'},
  {id:'q2',prompt:'측정 조건은?',quotes:[],notes:[],pages:[1],projectTitle:'p',intent:'측정 조건 확인',listenFor:['기간','비교 기준'],answerTarget:'y'}];

function stub(options:{scoreRow?:Record<string,unknown>|null;onRpc:(name:string,body:any)=>unknown}) {
  const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','PROOFOLIO_MAX_COST_USD','OPENROUTER_SCORING_MODEL'] as const,before=keys.map(k=>process.env[k]);
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_synthetic';process.env.SUPABASE_SERVICE_ROLE_KEY='';
  const calls:Array<{path:string;body:any}>=[];
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input)),p=url.searchParams,body=init?.body?JSON.parse(String(init.body)):null;calls.push({path:url.pathname,body});
    if(url.pathname.startsWith('/rest/v1/rpc/'))return Response.json(options.onRpc(url.pathname.slice('/rest/v1/rpc/'.length),body));
    if(url.pathname==='/rest/v1/proofolio_test_summaries')return Response.json(p.get('owner_id')==='eq.'+owner?[{id:testId,code:'ABC234',title:'t',role:'designer',starts_at:new Date(Date.now()-1000).toISOString(),
      ends_at:new Date(Date.now()+60000).toISOString(),created_at:new Date().toISOString(),total_seconds:40,question_count:10,submission_count:1,completed_count:1,scored_count:1,average_score:'81'}]:[]);
    if(url.pathname==='/rest/v1/proofolio_submissions')return Response.json([{id:submissionId,test_id:testId,user_id:candidate,candidate_name:'응시자',birth_date:'2000-01-01',phone:'01000000000',
      joined_at:new Date().toISOString(),completed_at:new Date().toISOString(),run_id:runId}]);
    if(url.pathname==='/rest/v1/proofolio_submission_scores')return Response.json(options.scoreRow===undefined?[]:options.scoreRow?[options.scoreRow]:[]);
    if(url.pathname==='/rest/v1/proofolio_runs')return Response.json([{id:runId,user_id:candidate,state:'complete',track:'design',started_at:new Date().toISOString(),result:{questions}}]);
    if(url.pathname==='/rest/v1/proofolio_answers')return Response.json([{question_id:'q1',answer:'컴포넌트 12개를 직접 설계했고 이유는 일관성 때문입니다.',seconds:20},{question_id:'q2',answer:'',seconds:0}]);
    throw new Error('Unexpected URL '+url.pathname);
  };
  return {calls,restore(){globalThis.fetch=original;keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];});}};
}

test('scoreSubmission stores running then complete with code-computed scores, never a model-authored number',async()=>{
  const saved:any[]=[];const s=stub({onRpc:(name,body)=>{assert.equal(name,'proofolio_save_submission_score');assert.equal(body.p_user_id,candidate);saved.push(body.p_score);return submissionId;}});
  try{
    const generate=async(req:any)=>{assert.equal(req.kind,'AnswerScoring');assert.equal(req.model,'anthropic/claude-opus-5');assert.match(req.prompt,/답변 데이터/);
      return {items:[{question_id:'q1',relevance:'full',coverage:[{item:'기여 범위 확인',covered:true,evidence:'직접 설계'},{item:'직접 수행 범위',covered:true,evidence:'12개'}],depth:2,logic:2,creativity:1,comment:'범위와 이유를 설명했어요.'},
        {question_id:'q2',relevance:'none',coverage:[{item:'측정 조건 확인',covered:false,evidence:''},{item:'기간',covered:false,evidence:''},{item:'비교 기준',covered:false,evidence:''}],depth:0,logic:0,creativity:0,comment:'답변이 없어요.'}]};};
    assert.equal(await scoreSubmission({submissionId,userId:candidate,runId},{generate}),'complete');
    assert.deepEqual(saved.map(x=>x.state),['running','complete']);
    assert.equal(saved[1].overallScore,Math.round((90+0)/2));assert.equal(saved[1].items[0].score,90);assert.equal(saved[1].items[1].score,0);
    assert.equal(saved[1].model,'anthropic/claude-opus-5');assert.equal(typeof saved[1].costUsd,'number');
    assert.ok(AnswerScoring.safeParse({items:[]}).success);
  }finally{s.restore();}
});

test('scoreSubmission without an approved budget records a failure instead of calling a model; complete rows are not rescored',async()=>{
  const saved:any[]=[];const s=stub({onRpc:(_n,body)=>{saved.push(body.p_score);return submissionId;}});
  try{
    process.env.PROOFOLIO_MAX_COST_USD='0';
    assert.equal(await scoreSubmission({submissionId,userId:candidate,runId}),'failed');
    assert.equal(saved.at(-1).state,'failed');assert.match(saved.at(-1).error,/max-cost-usd|PROOFOLIO_MAX_COST_USD/);assert.ok(!/sk-or-/.test(saved.at(-1).error));
  }finally{s.restore();}
  const done=stub({scoreRow:{submission_id:submissionId,state:'complete',model:'m',overall_score:81,items:[],error:null,scored_at:new Date().toISOString(),cost_usd:'0.1'},onRpc:()=>{throw new Error('should not save');}});
  try{
    assert.equal(await scoreSubmission({submissionId,userId:candidate,runId},{generate:async()=>{throw new Error('should not call');}}),'complete');
    const listed=await listSubmissions(testId,owner);
    assert.equal(listed.test.averageScore,81);assert.equal(listed.test.scoredCount,1);
    assert.equal(listed.submissions[0].score?.overallScore,81);assert.equal(listed.submissions[0].score?.costUsd,0.1);
    assert.deepEqual(toScore({submission_id:'x',state:'failed',model:null,overall_score:null,items:null as any,error:'e',scored_at:null,cost_usd:null}).items,[]);
    await assert.rejects(rescoreSubmission(testId,submissionId,other),/찾을 수 없/);
    assert.equal(await scoresFor(['not-a-uuid']).then(m=>m.size),0);
  }finally{done.restore();}
  assert.equal(scoringModel({}),'anthropic/claude-opus-5');
  assert.throws(()=>scoringModel({OPENROUTER_SCORING_MODEL:'openrouter/auto'}),/지원하지 않는/);
});
