import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {sessionUser, sessionCookie, SESSION_COOKIE} from '../web/lib/server/session.ts';
import {publicStatus, storageMode, syncRun, syncAnswers, type StoredRun} from '../web/lib/server/database.ts';
import {ROOT, ownedStatus, saveAnswers} from '../web/lib/server/runner.ts';
import {cleanupExpiredRuns} from '../web/lib/server/retention.ts';
process.env.PROOFOLIO_CONTEST_MODE='0'; // Keep member/legacy retention regression independent of the contest edition.

test('guest identity: stable secret cookie, hashed user ID, secure flags, no public ownership fields', async()=>{
  const request = new Request('https://proofolio.example/api/analyze');
  assert.equal(sessionUser(request), null);
  const user = sessionUser(request, true)!;
  assert.equal(user.id, createHash('sha256').update(user.token).digest('hex'));
  assert.notEqual(sessionUser(request, true)!.id, user.id);
  assert.deepEqual(sessionUser(new Request(request,{headers:{cookie:`other=x; ${SESSION_COOKIE}=${user.token}`}})), user);
  assert.equal(sessionUser(new Request(request,{headers:{cookie:`${SESSION_COOKIE}=invalid`}})), null);
  const cookie = sessionCookie(request,user.token);
  assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'lax');
  assert.equal(sessionCookie(new Request('http://127.0.0.1:3100'),user.token).secure,false);
  const runId=randomUUID(), dir=resolve(ROOT,'output/web/runs',runId);
  mkdirSync(dir,{recursive:true});
  const status={runId,userId:user.id,pdfSha256:'a'.repeat(64),metrics:{secret:'private'},requestedQuestions:10,schemaVersion:'0.17',state:'complete'} as StoredRun;
  writeFileSync(resolve(dir,'status.json'),JSON.stringify(status));
  assert.equal((await ownedStatus(runId,user.id)).runId,runId);
  for(const id of [undefined,'f'.repeat(64)]) await assert.rejects(ownedStatus(runId,id),/찾을 수/);
  assert.deepEqual(publicStatus(status),{runId,state:'complete'});
  const withAsset={...status,result:{sourceAssets:[{id:'pdf',page:0,kind:'pdf',path:'private/path'}]}} as StoredRun;
  assert.deepEqual(publicStatus(withAsset).result!.sourceAssets,[{id:'pdf',page:0,kind:'pdf'}]);
  delete status.userId;writeFileSync(resolve(dir,'status.json'),JSON.stringify(status));
  await assert.rejects(ownedStatus(runId,user.id),/찾을 수/);
});

test('retention: protect examples; delete only expired owned files before guarded purge, fail closed on storage errors',async()=>{
  const keys=['PROOFOLIO_STORAGE','SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'] as const;
  const before=keys.map(k=>process.env[k]),original=globalThis.fetch;
  const runId=randomUUID(),exampleId=randomUUID(),userId='b'.repeat(64),dir=resolve(ROOT,'output/web/runs',runId);
  mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'test-only.json'),'{}');
  const calls:string[]=[];let storageFailure=true;
  try {
    process.env.PROOFOLIO_STORAGE='supabase';process.env.SUPABASE_URL='https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY='sb_secret_synthetic';process.env.SUPABASE_SERVICE_ROLE_KEY='';
    globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname==='/rest/v1/proofolio_runs'){
        assert.match(url.searchParams.get('expires_at')!,/^lte\./);
        return Response.json([{id:exampleId,user_id:userId},{id:runId,user_id:userId}]);
      }
      if(url.pathname==='/rest/v1/proofolio_examples')return Response.json([{source_run_id:exampleId}]);
      if(url.pathname==='/storage/v1/object/list/proofolio-private'){
        assert.equal(JSON.parse(init!.body as string).prefix,`${userId}/${runId}`);
        calls.push('list');return Response.json([{id:'synthetic-object',name:'portfolio.pdf'}]);
      }
      if(url.pathname==='/storage/v1/object/proofolio-private'){
        assert.equal(init!.method,'DELETE');assert.deepEqual(JSON.parse(init!.body as string).prefixes,[`${userId}/${runId}/portfolio.pdf`]);
        calls.push('remove');return storageFailure?Response.json({message:'synthetic failure'},{status:403}):Response.json([]);
      }
      if(url.pathname==='/rest/v1/rpc/proofolio_purge_recruiting'){calls.push('purge-recruiting');return Response.json(null);}
      assert.equal(url.pathname,'/rest/v1/rpc/proofolio_purge_run');
      assert.equal(existsSync(dir),false); // Keep the DB retry marker until local deletion has succeeded.
      assert.equal(JSON.parse(init!.body as string).p_run_id,runId);calls.push('purge');return Response.json(null);
    };
    await assert.rejects(cleanupExpiredRuns(),/만료 파일 삭제 실패/);
    assert.deepEqual(calls,['list','remove']);assert.equal(existsSync(dir),true);
    calls.length=0;storageFailure=false;await cleanupExpiredRuns();
    assert.deepEqual(calls,['list','remove','purge','purge-recruiting']);assert.equal(existsSync(dir),false);
  }finally{globalThis.fetch=original;keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});}
});

test('Supabase RPC: fail-closed setup, actual counts, sanitized errors and immutable local retry',async()=>{
  const keys=['PROOFOLIO_STORAGE','SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'] as const;
  const before=keys.map(key=>process.env[key]), original=globalThis.fetch;
  const status:StoredRun={runId:randomUUID(),userId:'a'.repeat(64),track:'design',fileName:'synthetic.pdf',state:'complete',stage:3,
    startedAt:'2026-09-20T00:00:00Z',finishedAt:'2026-09-20T00:00:01Z',storage:'supabase',pdfSha256:'b'.repeat(64),requestedQuestions:10,
    result:{status:'needs_review',pageCount:1,projects:[],evidenceCount:1,estimatedCostUsd:0,maxQuestions:10,qualityIssues:[],
      questions:[{id:'q7',prompt:'작업을 설명해주세요.',quotes:['검증된 원문'],notes:[],pages:[1],projectTitle:'프로젝트',intent:'설명',listenFor:[],answerTarget:'선택'}]}};
  const answers=[{questionId:'q7',answer:'합성 답변',seconds:3}];
  const calls:Array<{url:string;body:any;headers:Record<string,string>}>=[];
  let fail=false, wrongCount=false;
  try {
    process.env.PROOFOLIO_STORAGE='supabase';process.env.SUPABASE_URL='https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY='';process.env.SUPABASE_SERVICE_ROLE_KEY='';
    globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(!init?.body)return Response.json([{id:status.runId,user_id:status.userId,track:status.track,file_name:status.fileName,
        pdf_sha256:status.pdfSha256,requested_question_count:10,state:status.state,started_at:status.startedAt,finished_at:status.finishedAt,result:status.result,metrics:null,schema_version:null}]);
      const body=JSON.parse(init.body as string);
      calls.push({url,body,headers:init!.headers as Record<string,string>});
      if(fail && url.endsWith('proofolio_save_answers')) return Response.json({error:'secret SQL data'}, {status:503});
      return Response.json(url.endsWith('proofolio_sync_run')?status.runId:wrongCount?10:1);
    };
    assert.equal(storageMode({}), 'local');assert.throws(()=>storageMode({PROOFOLIO_STORAGE:'bad'}));
    await assert.rejects(syncRun(status),/서버 전용 키/);assert.equal(calls.length,0);
    process.env.SUPABASE_SECRET_KEY='sb_secret_synthetic';
    await syncAnswers(status,answers);
    assert.equal(calls[0].body.p_run.requested_question_count,10);
    assert.deepEqual(calls[0].body.p_run.result.questions,status.result!.questions);
    assert.equal(calls[0].headers.Authorization,undefined);assert.equal(calls[0].headers.apikey,'sb_secret_synthetic');
    assert.deepEqual(calls[1].body.p_answers,answers);
    wrongCount=true;await assert.rejects(syncAnswers(status,answers),/개수가 일치/);wrongCount=false;
    const dir=resolve(ROOT,'output/web/runs',status.runId);mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'status.json'),JSON.stringify(status));
    fail=true;await assert.rejects(saveAnswers(status.runId,answers),e=>e instanceof Error&&/503/.test(e.message)&&!e.message.includes('secret SQL'));
    const backup=readFileSync(resolve(dir,'answers.json'),'utf8');
    fail=false;assert.equal(await saveAnswers(status.runId,answers),1);
    assert.equal(readFileSync(resolve(dir,'answers.json'),'utf8'),backup);
    await assert.rejects(saveAnswers(status.runId,[{...answers[0],answer:'changed'}]),/덮어쓰지/);
    process.env.SUPABASE_SECRET_KEY='';process.env.SUPABASE_SERVICE_ROLE_KEY='legacy-test';await syncRun(status);
    assert.equal(calls.at(-1)!.headers.Authorization,'Bearer legacy-test');
    const n=calls.length;await syncRun({...status,storage:'local'});assert.equal(calls.length,n);
  } finally {
    globalThis.fetch=original;keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];});
  }
});
