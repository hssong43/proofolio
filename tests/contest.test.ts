import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contestSettings } from '../web/lib/server/contest.ts';
import { runUser } from '../web/lib/server/access.ts';
import { sessionUser, SESSION_COOKIE } from '../web/lib/server/session.ts';
import { ownedStatus, ROOT } from '../web/lib/server/runner.ts';
import { cleanupExpiredRuns } from '../web/lib/server/retention.ts';
import { loadEnv } from '../src/env.ts';

process.env.PROOFOLIO_CONTEST_MODE='1';
process.env.PROOFOLIO_CONTEST_CLOSED='0';
process.env.PROOFOLIO_CONTEST_ENDS_AT='2099-10-20T23:59:59+09:00';
process.env.PROOFOLIO_STORAGE='local';

test('contest deadline is Korea Oct 20, fail-closed invalid config, no later than 24h retention',()=>{
  const now=Date.parse('2026-09-20T00:00:00Z');
  assert.deepEqual(contestSettings({},now),{enabled:true,closed:false,expiresAt:'2026-09-21T00:00:00.000Z'});
  assert.equal(contestSettings({},Date.parse('2026-10-20T14:59:59Z')).closed,true);
  assert.equal(contestSettings({PROOFOLIO_CONTEST_MODE:'0'},now).enabled,false);
  assert.equal(contestSettings({PROOFOLIO_CONTEST_CLOSED:'1'},now).closed,true);
  for(const end of ['bad','2026-10-20','2026-10-20T23:59:59'])assert.equal(contestSettings({PROOFOLIO_CONTEST_ENDS_AT:end},now).closed,true);
  assert.equal(contestSettings({PROOFOLIO_CONTEST_ENDS_AT:'2026-09-20T01:00:00Z'},now).expiresAt,'2026-09-20T01:00:00.000Z');
  const env:NodeJS.ProcessEnv={PROOFOLIO_CONTEST_CLOSED:'1'};loadEnv(resolve('.env.example'),env);
  assert.equal(env.PROOFOLIO_CONTEST_MODE,'1');assert.equal(env.PROOFOLIO_CONTEST_CLOSED,'1');
  assert.equal(env.PROOFOLIO_CONTEST_ENDS_AT,'2026-10-20T23:59:59+09:00');
});

test('anonymous ownership: no account/network, foreign cookies and expired access cannot read saved runs',async()=>{
  const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No Auth/DB calls allowed');};
  try {
    const request=new Request('https://demo.example/api/analyze');
    const owner=sessionUser(request,true)!,other=sessionUser(request,true)!;
    const as=(token:string)=>new Request(request,{headers:{cookie:`${SESSION_COOKIE}=${token}; sb-access-token=ignored`}});
    const user=await runUser(as(owner.token));assert.equal(user.id,owner.id);assert.equal(user.member,false);assert.ok(user.guestExpiresAt);
    assert.equal('token' in user,false);assert.equal('authId' in user,false);
    await assert.rejects(runUser(request),/세션/);
    const id=randomUUID(),dir=resolve(ROOT,'output/web/runs',id);mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'status.json'),JSON.stringify({runId:id,userId:owner.id,state:'complete'}));
    assert.equal((await ownedStatus(id,user.id)).runId,id);
    await assert.rejects(ownedStatus(id,(await runUser(as(other.token))).id),/찾을 수/);
    process.env.PROOFOLIO_CONTEST_CLOSED='1';await assert.rejects(runUser(as(owner.token)),/종료/);
  } finally {globalThis.fetch=original;process.env.PROOFOLIO_CONTEST_CLOSED='0';}
});

test('rejected guest admission leaves no uploaded PDF or paid child on local disk',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'proofolio-guest-admission-'));mkdirSync(resolve(root,'src'));
  const script=`import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
    let calls=0;globalThis.fetch=async(input)=>{calls++;assert.ok(String(input).endsWith('/rpc/proofolio_start_guest_run'));return Response.json({error:'quota'},{status:409});};
    const {startRun}=await import(${JSON.stringify(new URL('../web/lib/server/runner.ts',import.meta.url).href)});
    await assert.rejects(startRun({bytes:Buffer.from('%PDF-test'),fileName:'private.pdf',track:'design',userId:'a'.repeat(64),maxQuestions:10,guestExpiresAt:new Date(Date.now()+60000).toISOString()}));
    assert.equal(calls,1);assert.equal(existsSync('output/web/runs'),false);`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8',timeout:10000,
    env:{...process.env,PROOFOLIO_ROOT:root,PROOFOLIO_STORAGE:'supabase',PROOFOLIO_MAX_COST_USD:'10',PROOFOLIO_BUDGET_LEDGER:'output/openrouter-budget.jsonl',
      OPENROUTER_API_KEY:'',SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_test_only',SUPABASE_SERVICE_ROLE_KEY:''}});
  assert.equal(result.status,0,result.stderr);
});

test('closed contest retention expires guests only, protects examples and active writers, then purges profiles',async()=>{
  const keys=['PROOFOLIO_STORAGE','SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','PROOFOLIO_CONTEST_CLOSED'] as const;
  const before=keys.map(k=>process.env[k]),original=globalThis.fetch,calls:string[]=[];
  const id=randomUUID(),protectedId=randomUUID(),activeId=randomUUID();
  try {
    process.env.PROOFOLIO_STORAGE='supabase';process.env.SUPABASE_URL='https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY='sb_secret_synthetic';process.env.SUPABASE_SERVICE_ROLE_KEY='';process.env.PROOFOLIO_CONTEST_CLOSED='1';
    globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/proofolio_runs'))return Response.json([id,protectedId,activeId].map(run=>({id:run,user_id:'a'.repeat(64),state:run===activeId?'failed':'complete',started_at:new Date(Date.now()-(run===activeId?0:86400000)).toISOString()})));
      if(url.pathname.endsWith('/proofolio_examples'))return Response.json([{source_run_id:protectedId}]);
      if(url.pathname.includes('/storage/')){assert.equal(JSON.parse(init!.body as string).prefix,`${'a'.repeat(64)}/${id}`);calls.push('list');return Response.json([]);}
      const rpc=url.pathname.split('/').at(-1)!;calls.push(rpc);
      if(rpc==='proofolio_purge_run')assert.equal(JSON.parse(init!.body as string).p_run_id,id);
      return Response.json(null);
    };
    await cleanupExpiredRuns();
    assert.deepEqual(calls,['proofolio_expire_guests','list','proofolio_purge_run','proofolio_purge_recruiting','proofolio_purge_guest_profiles']);
  } finally {globalThis.fetch=original;keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});}
});
