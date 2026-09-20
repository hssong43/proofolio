import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CODE_RE,normalizeCode,isValidCode} from '../web/lib/codes.ts';
import {testStatus,validatePeriod,formatDateTime} from '../web/lib/period.ts';
import {validateCandidate,isValidBirthDate,formatPhone} from '../web/lib/candidate.ts';
import {checkPassword,issueAdminToken,verifyAdminToken,issueCandidateToken,verifyCandidateToken,parseCookies,isAdminRequest,candidateOf,ADMIN_COOKIE,CANDIDATE_COOKIE,ADMIN_TTL_MS,cookieHeader} from '../web/lib/server/auth.ts';
import {generateCode,storeDir,createTest,getTest,findTestByCode,listTests,createSubmission,getSubmission,listSubmissions,completeSubmission} from '../web/lib/server/store.ts';

test('join codes avoid ambiguous characters and normalize loose input',()=>{
  for(let i=0;i<200;i++){const code=generateCode();assert.match(code,CODE_RE);assert.doesNotMatch(code,/[IO01]/);}
  assert.equal(normalizeCode(' ab c-2 34 '),'ABC234');
  assert.equal(normalizeCode('abcdefgh'),'ABCDEF');
  assert.equal(isValidCode('ABC234'),true);assert.equal(isValidCode('ABC0O1'),false);assert.equal(isValidCode('ABC23'),false);
});

test('test period status and validation',()=>{
  const t={startsAt:'2026-09-20T00:00:00.000Z',endsAt:'2026-09-21T00:00:00.000Z'},start=Date.parse(t.startsAt),end=Date.parse(t.endsAt);
  assert.equal(testStatus(t,start-1),'upcoming');assert.equal(testStatus(t,start),'open');assert.equal(testStatus(t,end),'open');assert.equal(testStatus(t,end+1),'closed');
  assert.equal(testStatus({startsAt:'bad',endsAt:'bad'}),'upcoming');
  assert.equal(validatePeriod(t.endsAt,t.startsAt).ok,false);assert.equal(validatePeriod('nope',t.endsAt).ok,false);assert.equal(validatePeriod(1,2).ok,false);
  const ok=validatePeriod('2026-09-20T09:00','2026-09-20T18:00');assert.equal(ok.ok,true);
  if(ok.ok){assert.match(ok.startsAt,/Z$/);assert.ok(Date.parse(ok.endsAt)>Date.parse(ok.startsAt));}
  assert.match(formatDateTime(t.startsAt),/2026\.09\.20 09:00/);assert.equal(formatDateTime('bad'),'-');
});

test('candidate info validation normalizes phone and rejects impossible dates',()=>{
  const now=new Date('2026-09-20T00:00:00Z');
  const ok=validateCandidate({name:' 홍길동 ',birthDate:'1999-02-28',phone:'010-1234-5678'},now);
  assert.deepEqual(ok,{ok:true,candidate:{name:'홍길동',birthDate:'1999-02-28',phone:'01012345678'}});
  assert.equal(formatPhone('01012345678'),'010-1234-5678');assert.equal(formatPhone('0212345678'),'021-234-5678');
  for(const bad of [{name:'',birthDate:'1999-02-28',phone:'01012345678'},{name:'a'.repeat(41),birthDate:'1999-02-28',phone:'01012345678'},
    {name:'홍',birthDate:'2001-02-30',phone:'01012345678'},{name:'홍',birthDate:'2030-01-01',phone:'01012345678'},{name:'홍',birthDate:'1999-2-28',phone:'01012345678'},
    {name:'홍',birthDate:'1999-02-28',phone:'1234567'},null])assert.equal(validateCandidate(bad,now).ok,false,JSON.stringify(bad));
  assert.equal(isValidBirthDate('1899-12-31'),false);
});

test('admin password check and signed session tokens',()=>{
  const env={PROOFOLIO_ADMIN_PASSWORD:'pw'},other={PROOFOLIO_ADMIN_PASSWORD:'other'};
  assert.equal(checkPassword('pw',env),true);assert.equal(checkPassword('PW',env),false);assert.equal(checkPassword('',env),false);
  assert.throws(()=>checkPassword('pw',{}),/PROOFOLIO_ADMIN_PASSWORD/);
  const now=1_700_000_000_000,token=issueAdminToken(now,env);
  assert.equal(verifyAdminToken(token,now+1,env),true);
  assert.equal(verifyAdminToken(token,now+ADMIN_TTL_MS+1,env),false);
  assert.equal(verifyAdminToken(token.slice(0,-1)+'0',now,env),false);
  assert.equal(verifyAdminToken(token,now,other),false);
  assert.equal(verifyAdminToken(undefined,now,env),false);assert.equal(verifyAdminToken('admin.x.y',now,env),false);
  const req=(cookie:string)=>new Request('http://127.0.0.1:3100/',{headers:{cookie}});
  assert.deepEqual(parseCookies('a=1; proofolio_admin=x.y;bad'),{a:'1',proofolio_admin:'x.y'});
  assert.equal(isAdminRequest(req(`${ADMIN_COOKIE}=${token}`),now,env),true);assert.equal(isAdminRequest(req('a=1'),now,env),false);
  const cand=issueCandidateToken('t1','s1',env);
  assert.deepEqual(verifyCandidateToken(cand,'s1',env),{testId:'t1'});assert.equal(verifyCandidateToken(cand,'s2',env),null);assert.equal(verifyCandidateToken(cand,'s1',other),null);
  assert.deepEqual(candidateOf(req(`${CANDIDATE_COOKIE}=${cand}`),'s1',env),{testId:'t1'});
  assert.match(cookieHeader('c','v w',new Request('https://x.test/'),5),/^c=v%20w; Path=\/; HttpOnly; SameSite=Lax; Max-Age=5; Secure$/);
  assert.doesNotMatch(cookieHeader('c','v',new Request('http://x.test/'),5),/Secure/);
});

test('json file store: unique codes, concurrent submissions, idempotent completion, path safety',async()=>{
  process.env.PROOFOLIO_STORE_DIR=mkdtempSync(join(tmpdir(),'proofolio-store-'));
  const dir=storeDir();assert.equal(dir,process.env.PROOFOLIO_STORE_DIR);
  const period={startsAt:'2026-09-20T00:00:00.000Z',endsAt:'2026-09-21T00:00:00.000Z'};
  const first=await createTest({title:'첫 테스트',...period},{nextCode:()=>'ABC234'});
  assert.equal(first.code,'ABC234');assert.equal(first.mode,'demo');assert.equal(first.questionCount,5);
  assert.ok(existsSync(join(dir,'tests',first.id+'.json')));assert.ok(existsSync(join(dir,'codes','ABC234.json')));
  const codes=['ABC234','DEF567'];const second=await createTest({title:'둘째',...period},{nextCode:()=>codes.shift()!});
  assert.equal(second.code,'DEF567');
  assert.equal((await findTestByCode(' abc-234 '))?.id,first.id);assert.equal(await findTestByCode('ZZZZZZ'),null);assert.equal(await findTestByCode('ab'),null);
  assert.equal((await getTest(first.id))?.title,'첫 테스트');
  await assert.rejects(getTest('../escape'),/ID/);await assert.rejects(getSubmission(first.id,'../x'),/ID/);
  await assert.rejects(createSubmission('00000000-0000-4000-8000-000000000000',{name:'x',birthDate:'1999-01-01',phone:'01012345678'}),/찾을 수 없/);
  const subs=await Promise.all(Array.from({length:25},(_,i)=>createSubmission(first.id,{name:`응시자${i}`,birthDate:'1999-01-01',phone:'01012345678'})));
  assert.equal(new Set(subs.map(s=>s.id)).size,25);assert.equal(readdirSync(join(dir,'submissions',first.id)).filter(f=>f.endsWith('.json')).length,25);
  const payload={role:'dev' as const,roleLabel:'개발자',questions:[{id:'demo-q1',prompt:'q',quotes:[],notes:[],source:'s'}],answers:[{questionId:'demo-q1',answer:'a',seconds:3}],elapsedSeconds:9,runId:null};
  const done1=await completeSubmission(first.id,subs[0].id,payload),done2=await completeSubmission(first.id,subs[0].id,payload);
  assert.equal(done1.state,'completed');assert.equal(done2.completedAt,done1.completedAt);assert.deepEqual(done2.answers,payload.answers);
  const listed=await listTests(Date.parse(period.startsAt)+1);
  assert.deepEqual(listed.map(t=>[t.code,t.status,t.submissionCount,t.completedCount]),[['DEF567','open',0,0],['ABC234','open',25,1]]);
  assert.equal((await listSubmissions(first.id)).length,25);
  await assert.rejects(completeSubmission(first.id,'00000000-0000-4000-8000-000000000000',payload),/찾을 수 없/);
});
