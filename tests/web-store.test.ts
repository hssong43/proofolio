import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CODE_RE,normalizeCode,isValidCode} from '../web/lib/codes.ts';
import {testStatus,validatePeriod,formatDateTime} from '../web/lib/period.ts';
import {validateCandidate,isValidBirthDate,formatPhone} from '../web/lib/candidate.ts';
import {issueAdminToken,verifyAdminToken,issueCandidateToken,verifyCandidateToken,parseCookies,adminOf,candidateOf,ADMIN_COOKIE,CANDIDATE_COOKIE,ADMIN_TTL_MS,cookieHeader} from '../web/lib/server/auth.ts';
import {hashPassword,verifyPassword,validateSignup,createAccount,findAccountByEmail,authenticate,SignupError} from '../web/lib/server/accounts.ts';
import {sessionSecret} from '../web/lib/server/secret.ts';
import {scoreAnswer,evaluateSubmission} from '../web/lib/server/evaluate.ts';
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

test('signed session tokens carry the account id and reject expiry, tampering and other secrets',()=>{
  const secret='s1',other='s2',id='00000000-0000-4000-8000-00000000aaaa';
  const now=1_700_000_000_000,token=issueAdminToken(id,secret,now);
  assert.deepEqual(verifyAdminToken(token,secret,now+1),{accountId:id});
  assert.equal(verifyAdminToken(token,secret,now+ADMIN_TTL_MS+1),null);
  assert.equal(verifyAdminToken(token.slice(0,-1)+'0',secret,now),null);
  assert.equal(verifyAdminToken(token,other,now),null);
  assert.equal(verifyAdminToken(undefined,secret,now),null);assert.equal(verifyAdminToken('admin.x.y.z',secret,now),null);
  assert.throws(()=>issueAdminToken(id,'',now),/비어/);
  const req=(cookie:string)=>new Request('http://127.0.0.1:3100/',{headers:{cookie}});
  assert.deepEqual(parseCookies('a=1; proofolio_admin=x.y;bad'),{a:'1',proofolio_admin:'x.y'});
  assert.deepEqual(adminOf(req(`${ADMIN_COOKIE}=${token}`),secret,now),{accountId:id});assert.equal(adminOf(req('a=1'),secret,now),null);
  const cand=issueCandidateToken('t1','s1',secret);
  assert.deepEqual(verifyCandidateToken(cand,'s1',secret),{testId:'t1'});assert.equal(verifyCandidateToken(cand,'s2',secret),null);assert.equal(verifyCandidateToken(cand,'s1',other),null);
  assert.deepEqual(candidateOf(req(`${CANDIDATE_COOKIE}=${cand}`),'s1',secret),{testId:'t1'});
  assert.match(cookieHeader('c','v w',new Request('https://x.test/'),5),/^c=v%20w; Path=\/; HttpOnly; SameSite=Lax; Max-Age=5; Secure$/);
  assert.doesNotMatch(cookieHeader('c','v',new Request('http://x.test/'),5),/Secure/);
});

test('mock evaluation is deterministic, scores evidence signals and applies the pass score',()=>{
  assert.deepEqual(scoreAnswer('   '),{score:0,comment:'답변이 없어요.',signals:[]});
  const weak=scoreAnswer('열심히 했습니다'),strong=scoreAnswer('이탈률 38%에서 21%로 줄인 결과는 4주간 A/B 테스트로 측정했습니다. 판단 기준은 퍼널 데이터였고 대안으로 튜토리얼 축소도 비교했습니다. 제가 직접 온보딩 3개 화면을 담당했습니다.');
  assert.ok(weak.score>0&&weak.score<50,String(weak.score));assert.ok(strong.score>=90,String(strong.score));
  assert.deepEqual(strong.signals,['numbers','reasoning','outcome','alternatives','ownership']);
  assert.equal(scoreAnswer('x'.repeat(5000)).score<=100,true);
  assert.deepEqual(scoreAnswer('열심히 했습니다'),weak);
  const questions=[{id:'q1',prompt:'a',quotes:[],notes:[],source:''},{id:'q2',prompt:'b',quotes:[],notes:[],source:''}];
  const ev=evaluateSubmission({questions,answers:[{questionId:'q1',answer:strong.comment&&'이유는 근거 수치 12%와 결과 측정, 대안 비교, 제가 직접 담당. 두 문장.',seconds:1}],passScore:50},new Date('2026-09-20T00:00:00Z'));
  assert.equal(ev.method,'mock-rules');assert.equal(ev.items.length,2);assert.equal(ev.items[1].score,0);
  assert.equal(ev.overallScore,Math.round(ev.items[0].score/2));assert.equal(ev.passed,ev.overallScore>=50);assert.equal(ev.evaluatedAt,'2026-09-20T00:00:00.000Z');
  assert.equal(evaluateSubmission({questions:[],answers:[],passScore:0}).passed,true);
});

test('accounts: scrypt hashes, signup validation, unique email index, authentication',async()=>{
  process.env.PROOFOLIO_STORE_DIR=mkdtempSync(join(tmpdir(),'proofolio-accounts-'));
  const hash=await hashPassword('correct horse');
  assert.match(hash,/^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword('correct horse',hash),true);assert.equal(await verifyPassword('wrong',hash),false);assert.equal(await verifyPassword('x','bogus'),false);
  assert.equal(validateSignup({email:'bad',password:'12345678',name:'a'}).ok,false);
  assert.equal((validateSignup({email:'A@B.co',password:'1234567',name:'a'}) as any).code,'password');
  assert.equal((validateSignup({email:'a@b.co',password:'12345678',passwordConfirm:'12345679',name:'a'}) as any).code,'mismatch');
  assert.equal((validateSignup({email:'a@b.co',password:'12345678',name:''}) as any).code,'name');
  const ok=validateSignup({email:' Recruiter@Example.com ',password:'12345678',passwordConfirm:'12345678',name:' 김담당 ',company:'프루폴리오'});
  assert.deepEqual(ok,{ok:true,email:'recruiter@example.com',password:'12345678',name:'김담당',company:'프루폴리오'});
  const account=await createAccount({email:'Recruiter@Example.com',password:'12345678',name:'김담당',company:'프루폴리오'});
  assert.equal(account.email,'recruiter@example.com');assert.ok(existsSync(join(process.env.PROOFOLIO_STORE_DIR,'accounts',account.id+'.json')));
  await assert.rejects(createAccount({email:'recruiter@example.com',password:'12345678',name:'중복'}),(e:unknown)=>e instanceof SignupError&&e.code==='exists');
  assert.equal((await findAccountByEmail('RECRUITER@example.com'))?.id,account.id);assert.equal(await findAccountByEmail('nobody@example.com'),null);
  assert.equal((await authenticate('recruiter@example.com','12345678'))?.id,account.id);assert.equal(await authenticate('recruiter@example.com','nope'),null);
  const s1=await sessionSecret(),s2=await sessionSecret();assert.equal(s1,s2);assert.match(s1,/^[0-9a-f]{64}$/);
  assert.equal(await sessionSecret({PROOFOLIO_SESSION_SECRET:'env-secret'}),'env-secret');
});

test('json file store: unique codes, concurrent submissions, idempotent completion, path safety',async()=>{
  process.env.PROOFOLIO_STORE_DIR=mkdtempSync(join(tmpdir(),'proofolio-store-'));
  const dir=storeDir();assert.equal(dir,process.env.PROOFOLIO_STORE_DIR);
  const period={startsAt:'2026-09-20T00:00:00.000Z',endsAt:'2026-09-21T00:00:00.000Z'};
  const first=await createTest({title:'첫 테스트',role:'designer',...period},{nextCode:()=>'ABC234'});
  assert.equal(first.code,'ABC234');assert.equal(first.mode,'demo');assert.equal(first.questionCount,10);assert.equal(first.role,'designer');assert.equal(first.passScore,70);
  assert.ok(existsSync(join(dir,'tests',first.id+'.json')));assert.ok(existsSync(join(dir,'codes','ABC234.json')));
  const codes=['ABC234','DEF567'];const second=await createTest({title:'둘째',role:'mkt',passScore:40,createdBy:'00000000-0000-4000-8000-00000000aaaa',...period},{nextCode:()=>codes.shift()!});
  assert.equal(second.code,'DEF567');assert.equal(second.passScore,40);assert.equal(second.createdBy,'00000000-0000-4000-8000-00000000aaaa');
  assert.equal((await findTestByCode(' abc-234 '))?.id,first.id);assert.equal(await findTestByCode('ZZZZZZ'),null);assert.equal(await findTestByCode('ab'),null);
  assert.equal((await getTest(first.id))?.title,'첫 테스트');
  await assert.rejects(getTest('../escape'),/ID/);await assert.rejects(getSubmission(first.id,'../x'),/ID/);
  await assert.rejects(createSubmission('00000000-0000-4000-8000-000000000000',{name:'x',birthDate:'1999-01-01',phone:'01012345678'}),/찾을 수 없/);
  const subs=await Promise.all(Array.from({length:25},(_,i)=>createSubmission(first.id,{name:`응시자${i}`,birthDate:'1999-01-01',phone:'01012345678'})));
  assert.equal(new Set(subs.map(s=>s.id)).size,25);assert.equal(readdirSync(join(dir,'submissions',first.id)).filter(f=>f.endsWith('.json')).length,25);
  const payload={role:'dev' as const,roleLabel:'개발자',questions:[{id:'demo-q1',prompt:'q',quotes:[],notes:[],source:'s'}],answers:[{questionId:'demo-q1',answer:'이유는 근거 수치 12%와 결과 측정, 대안 비교, 제가 직접 담당했습니다. 두 문장입니다.',seconds:3}],elapsedSeconds:9,runId:null};
  const done1=await completeSubmission(first.id,subs[0].id,payload),done2=await completeSubmission(first.id,subs[0].id,payload);
  assert.equal(done1.state,'completed');assert.equal(done2.completedAt,done1.completedAt);assert.deepEqual(done2.answers,payload.answers);
  assert.ok(done1.evaluation);assert.equal(done1.evaluation.passScore,70);assert.equal(done1.evaluation.passed,done1.evaluation.overallScore>=70);assert.deepEqual(done2.evaluation,done1.evaluation);
  const listed=await listTests(Date.parse(period.startsAt)+1);
  assert.deepEqual(listed.map(t=>[t.code,t.status,t.submissionCount,t.completedCount,t.passedCount]),[['DEF567','open',0,0,0],['ABC234','open',25,1,done1.evaluation.passed?1:0]]);
  assert.equal((await listSubmissions(first.id)).length,25);
  await assert.rejects(completeSubmission(first.id,'00000000-0000-4000-8000-000000000000',payload),/찾을 수 없/);
  // 예전 파일(role/passScore 없음)도 기본값으로 읽힌다
  const legacyId='00000000-0000-4000-8000-0000000000ab';const {role:_r,passScore:_p,...legacy}={...first,id:legacyId,code:'LEGACY'};
  writeFileSync(join(dir,'tests',legacyId+'.json'),JSON.stringify(legacy));
  const read=await getTest(legacyId);assert.equal(read?.role,'designer');assert.equal(read?.passScore,70);
});
