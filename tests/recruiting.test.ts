import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalRunId,validateNewTest,ownedTest,listSubmissions,candidateSubmission,submissionDetail,authorizeCandidateAnalysis} from '../web/lib/server/recruiting.ts';
import {safeReturnPath} from '../web/lib/params.ts';
import {testStatus} from '../web/lib/period.ts';
import {validateCandidate} from '../web/lib/candidate.ts';

test('recruiting input: canonical IDs only, 6–10 questions, dates, candidate fields and safe auth return',()=>{
  const id=randomUUID();
  assert.equal(canonicalRunId({runId:id}),id);
  for(const body of [{runId:id,questions:[]},{runId:id,answers:[]},{runId:'../other'},{runId:null},{}])
    assert.throws(()=>canonicalRunId(body));
  const body={title:'실제 테스트',role:'mkt',startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+60000).toISOString()};
  for(const count of [6,10])assert.equal(validateNewTest({...body,questionCount:count}).question_count,count);
  for(const count of [0,5,11,'10',6.5])assert.throws(()=>validateNewTest({...body,questionCount:count}));
  assert.throws(()=>validateNewTest({...body,role:'owner'}));
  assert.throws(()=>validateNewTest({...body,endsAt:body.startsAt}));
  assert.equal(testStatus(body,Date.parse(body.endsAt)),'closed');
  assert.equal(validateCandidate({name:'예제',birthDate:'2000-02-30',phone:'01000000000'}).ok,false);
  assert.equal(validateCandidate({name:'예제',birthDate:'2000-02-29',phone:'010-0000-0000'}).ok,true);
  assert.equal(safeReturnPath('/dashboard'),'/dashboard');
  assert.equal(safeReturnPath('/test?submission='+id),'/test?submission='+id);
  for(const path of ['https://evil.invalid','//evil.invalid','/\\evil.invalid','/api/auth','/dashboard/../api/auth','/dashboard\n'])
    assert.equal(safeReturnPath(path),undefined);
});

test('recruiting reads are owner-scoped; candidate preflight preserves role/count and shared cards hide source files',async()=>{
  const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'] as const,before=keys.map(k=>process.env[k]);
  const owner='a'.repeat(64),candidate='b'.repeat(64),foreign='c'.repeat(64);
  const testId=randomUUID(),id=randomUUID(),runId=randomUUID();
  const t={id:testId,owner_id:owner,code:'ABC234',title:'합성',role:'designer',starts_at:new Date(Date.now()-60000).toISOString(),
    ends_at:new Date(Date.now()+60000).toISOString(),created_at:new Date().toISOString(),total_seconds:40,question_count:10,submission_count:1,completed_count:0};
  const s={id,test_id:testId,user_id:candidate,candidate_name:'합성 응시자',birth_date:'2000-01-01',phone:'01000000000',joined_at:t.created_at,completed_at:null,run_id:null as string|null};
  let submissionReads=0;
  try{
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_synthetic';process.env.SUPABASE_SERVICE_ROLE_KEY='';
    globalThis.fetch=async(input)=>{
      const url=new URL(String(input)),p=url.searchParams;
      if(url.pathname==='/rest/v1/proofolio_test_summaries')return Response.json(p.get('owner_id')==='eq.'+owner?[t]:[]);
      if(url.pathname==='/rest/v1/proofolio_tests')return Response.json([t]);
      if(url.pathname==='/rest/v1/proofolio_submissions'){
        submissionReads++;assert.match(p.get('expires_at')!,/^gt\./);
        return Response.json(p.has('user_id')&&p.get('user_id')!=='eq.'+candidate?[]:[s]);
      }
      if(url.pathname==='/rest/v1/proofolio_runs')return Response.json([{id:runId,user_id:candidate,state:'complete',track:'design',started_at:t.created_at,
        file_name:'synthetic.pdf',result:{questions:[],sourceAssets:[{id:'private',path:'secret/path'}]}}]);
      if(url.pathname==='/rest/v1/proofolio_answers')return Response.json([]);
      if(url.pathname==='/rest/v1/proofolio_submission_scores')return Response.json([]);
      throw new Error('Unexpected URL');
    };
    await assert.rejects(ownedTest(testId,foreign),/찾을 수/);
    await assert.rejects(listSubmissions(testId,foreign),/찾을 수/);
    await assert.rejects(submissionDetail(testId,id,foreign),/찾을 수/);
    assert.equal(submissionReads,0,'Do not read any PII before owner authorization');
    assert.equal((await listSubmissions(testId,owner)).submissions.length,1);
    await assert.rejects(candidateSubmission(id,foreign),/찾을 수/);
    assert.equal((await candidateSubmission(id,candidate)).submission.id,id);
    await authorizeCandidateAnalysis(id,candidate,'design',10);
    await assert.rejects(authorizeCandidateAnalysis(id,candidate,'marketing',10),/바꿀 수/);
    await assert.rejects(authorizeCandidateAnalysis(id,candidate,'design',6),/바꿀 수/);
    s.run_id=runId;
    await assert.rejects(authorizeCandidateAnalysis(id,candidate,'design',10),/기존 응시/);
    const detail=await submissionDetail(testId,id,owner);
    assert.equal(detail.run?.result?.sourceAssets,undefined);
    assert.equal('userId' in detail.run!,false);
    t.ends_at=new Date(Date.now()-1000).toISOString();s.run_id=null;
    await assert.rejects(authorizeCandidateAnalysis(id,candidate,'design',10),/응시 기간/);
  }finally{globalThis.fetch=original;keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];});}
});
