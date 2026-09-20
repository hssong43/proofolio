import { test, expect, type BrowserContext } from '@playwright/test';
import type { AnswerRecord, ClientResult } from '../lib/types';
import { mockPdfUpload } from './upload-fixture';

const upload={name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nsynthetic UI fixture')};
const runId='00000000-0000-4000-8000-000000000001';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=','base64');
const fixture=(count:number):ClientResult=>({status:'needs_review',qualityIssues:['selected_points_uncovered'],pageCount:10,
  projects:[{key:'p',title:'합성 테스트 프로젝트',pages:[1,2]}],evidenceCount:count,estimatedCostUsd:0,maxQuestions:10,
  sourceAssets:[{id:'pdf',page:0,kind:'pdf'},...Array.from({length:count},(_,i)=>({id:`page-${i+1}`,page:i+1,kind:'page' as const}))],
  questions:Array.from({length:count},(_,i)=>({id:`q${i+1}`,prompt:`테스트 질문 ${i+1}: 이 작업에서 맡은 범위와 판단 근거를 설명해주세요.`,
    quotes:[`합성 원문 ${i+1}\n두 번째 줄`],notes:[],pages:[i+1],projectTitle:'합성 테스트 프로젝트',intent:'연결 검사',listenFor:[],answerTarget:'설명'}))});
const member=(context:BrowserContext)=>context.route('**/api/auth',route=>route.fulfill({json:{user:{email:'synthetic@example.com',name:'테스트'},configured:true}}));
test.beforeEach(async({context})=>{
  await context.route(`**/api/analyze/${runId}/source?**`,r=>{
    const url=new URL(r.request().url());expect(url.searchParams.get('view')).toBe('1');
    expect(url.searchParams.get('asset')).toMatch(/^page-\d+$/);
    return r.fulfill({contentType:'image/png',body:png});
  });
});

for(const [role,track,count] of [['디자이너','design',10],['마케터','marketing',2],['디자이너','design',7],['마케터','marketing',9]] as const)
test(`${track} ${count}: generated count, per-question ACK, save retry without analysis`,async({page,context},testInfo)=>{
  await member(context);
  const result=fixture(count),answers:AnswerRecord[]=[],attempts:AnswerRecord[]=[];
  let uploads=0,polls=0,release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const problems:string[]=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&!m.text().includes('503 (Service Unavailable)'))problems.push(m.text());});
  await mockPdfUpload(context, runId, { track, maxQuestions: 10 });
  await context.route('**/api/analyze',route=>{
    uploads++;expect(route.request().postDataJSON()).toEqual({runId});return route.fulfill({json:{runId}});
  });
  await context.route(`**/api/analyze/${runId}`,route=>route.fulfill({json:{runId,track,state:++polls===1?'running':'complete',stage:1,result,answers,
    storageError:count===2?'합성 원문 저장 경고':undefined}}));
  await context.route(`**/api/analyze/${runId}/answers`,async route=>{
    expect(route.request().method()).toBe('PATCH');const a=route.request().postDataJSON() as AnswerRecord;attempts.push(a);
    if(track==='marketing'&&attempts.length===1){await route.fulfill({status:503,json:{error:'합성 저장 실패'}});return;}
    if(track==='marketing'&&attempts.length===2)await gate;
    if(!answers.some(x=>x.questionId===a.questionId))answers.push(a);
    await route.fulfill({json:{ok:true,saved:a.questionId,answers,storage:'supabase'}});
  });
  await page.goto('/');await expect(page).toHaveTitle('Proofolio');await expect(page).toHaveURL('http://127.0.0.1:3101/');
  await expect(page.getByText(/근거에 따라 더 적을/)).toHaveCount(0);
  await page.getByRole('button',{name:role,exact:true}).click();await page.getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.getByText(/예상 약 8분/)).toBeVisible();
  await expect(page.getByText(/근거가 부족|검토|검수/)).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles(upload);await page.getByRole('button',{name:'AI 분석 시작',exact:true}).click();
  await expect(page.getByRole('heading',{name:`질문 ${count}개, 각 40초예요`})).toBeVisible();
  await expect(page.getByLabel(`생성된 질문 ${count}개 미리보기`).locator('div')).toHaveCount(count);
  await expect(page.getByText(/목표 6~10개 \/ 생성|검토 권장|부분 결과|포트폴리오 전체나 작성자의 진위|선정한 핵심 포인트/)).toHaveCount(0);
  if(count===2)await expect(page.locator('.error-box[role=status]')).toHaveText('합성 원문 저장 경고');
  if(count===7)await page.screenshot({path:testInfo.outputPath('ready.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'준비 완료'}).click();
  for(const [i,q]of result.questions.entries()){
    await expect(page.getByText(`Q${i+1} / ${count}`,{exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:q.prompt,exact:true})).toBeVisible();await expect(page.locator('blockquote, pre')).toHaveCount(0);
    await expect(page.getByRole('img',{name:`질문 연결 원본 포트폴리오 ${i+1}페이지`})).toBeVisible();
    await expect(page.getByText(q.quotes[0],{exact:true})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(i===0)await page.screenshot({path:testInfo.outputPath('question.png'),fullPage:true,animations:'disabled'});
    await page.getByRole('textbox',{name:'답변',exact:true}).fill(`테스트 답변 ${i+1}`);
    await page.getByRole('button',{name:i===count-1?'제출하고 완료':'제출하고 다음',exact:true}).click();
    if(i===0&&track==='marketing'){
      await expect(page.locator('.error-box[role="alert"]')).toContainText('합성 저장 실패');await expect(page.getByRole('textbox',{name:'답변',exact:true})).toHaveValue('테스트 답변 1');
      const seconds=await page.getByRole('timer').innerText();await page.waitForTimeout(1100);expect(await page.getByRole('timer').innerText()).toBe(seconds);
      await page.getByRole('button',{name:'답변 저장 재시도'}).click();await expect(page.getByText('저장 중 · 서버 응답을 기다려요')).toBeVisible();
      await expect.poll(()=>attempts.length).toBe(2);expect(attempts[1]).toEqual(attempts[0]);await expect(page.getByText(`Q1 / ${count}`,{exact:true})).toBeVisible();release();
    }
  }
  await expect(page.getByRole('heading',{name:'저장 완료',exact:true})).toBeVisible();
  await expect(page.getByText(/자동 평가|합불|검토|검수/)).toHaveCount(0);
  await expect(page.getByText('답변을 Supabase에 저장했어요.',{exact:true})).toBeVisible();
  expect(answers.map(a=>a.answer)).toEqual(result.questions.map((_,i)=>`테스트 답변 ${i+1}`));expect(uploads).toBe(1);expect(polls).toBe(2);expect(problems).toEqual([]);
  await expect(page.locator('nextjs-portal [data-nextjs-dialog-overlay]')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('saved.png'),fullPage:true,animations:'disabled'});
});

test('guest demo reads stored seven questions without upload, model call or answer write',async({page,context})=>{
  await context.route('**/api/auth',r=>r.fulfill({json:{user:null,configured:true}}));
  const result=fixture(7);
  await context.route('**/api/examples/design',r=>r.fulfill({json:{title:'기존 결과',notice:'검토 권장 항목이 남아 있어요.',result,
    images:result.questions.map(q=>({page:q.pages[0],url:`/api/examples/design/image?page=${q.pages[0]}`})),portfolioUrl:'/api/examples/design/portfolio'}}));
  await context.route('**/api/examples/design/image?**',r=>r.fulfill({contentType:'image/png',body:png}));
  const unexpected:string[]=[];await context.route('**/api/analyze**',r=>{unexpected.push(r.request().url());return r.abort();});
  await page.goto('/?demo=1&questions=6');await page.getByRole('button',{name:'디자이너',exact:true}).click();await page.getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.getByRole('heading',{name:'질문 7개, 각 40초예요'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
  await expect(page.getByText(/기존 생성 결과 7개를 체험해요/)).toBeVisible();
  await expect(page.getByText(/검토 권장|선정한 핵심 포인트/)).toHaveCount(0);
  await page.getByRole('button',{name:'준비 완료'}).click();
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
  for(let i=0;i<7;i++){
    const image=page.getByRole('img',{name:`질문 연결 원본 포트폴리오 ${i+1}페이지`});
    await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(page.locator('.question-layout h3')).toHaveText(result.questions[i].prompt);
    await expect(page.locator('blockquote, pre')).toHaveCount(0);
    await expect(page.getByText(/예제 포트폴리오는/)).toHaveCount(0);
    await expect(page.getByRole('link',{name:'전체 포트폴리오 보기 ↗'})).toHaveAttribute('href','/api/examples/design/portfolio');
    expect(await page.locator('.question-layout').evaluate(el=>{
      const source=el.querySelector('.question-originals')!,question=el.querySelector('h3')!,answer=el.querySelector('textarea')!;
      return !!(source.compareDocumentPosition(question)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(question.compareDocumentPosition(answer)&Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await page.getByRole('button',{name:i===6?'제출하고 완료':'제출하고 다음',exact:true}).click();
  }
  await expect(page.getByRole('heading',{name:'데모 완료'})).toBeVisible();expect(unexpected).toEqual([]);
  await expect(page.getByText(/자동 평가|합불|검토|검수/)).toHaveCount(0);
  await expect(page.getByText('데모 답변은 서버에 저장하지 않아요.',{exact:true})).toBeVisible();
});

test('email dialog excludes Google, handles confirmation response and login',async({page,context},testInfo)=>{
  let signedIn=false;const actions:string[]=[];
  await context.route('**/api/auth',route=>{
    if(route.request().method()==='POST'){const b=route.request().postDataJSON();actions.push(b.action);if(b.action==='signin')signedIn=true;
      return route.fulfill({json:{ok:true,message:b.action==='signup'?'이메일의 인증 링크를 눌러 가입을 완료해주세요.':'로그인했어요.'}});}
    return route.fulfill({json:{configured:true,user:signedIn?{email:'synthetic@example.com',name:''}:null}});
  });
  await page.goto('/');await page.getByRole('button',{name:'이메일 로그인'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('button',{name:/Google|구글/})).toHaveCount(0);
  await page.getByRole('button',{name:'계정 만들기',exact:true}).click();await page.getByLabel('이메일',{exact:true}).fill('synthetic@example.com');
  await page.getByLabel('비밀번호',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'가입하고 인증 메일 받기'}).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('인증 링크');
  await page.screenshot({path:testInfo.outputPath('email-signup.png'),animations:'disabled'});
  await page.getByRole('button',{name:'기존 계정으로 로그인'}).click();await page.getByRole('button',{name:'로그인',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByRole('button',{name:'내 기록',exact:true})).toBeVisible();expect(actions).toEqual(['signup','signin']);
});

test('server-confirmed answer and unsent draft resume after refresh',async({page,context})=>{
  await member(context);const result=fixture(6),answers:AnswerRecord[]=[];
  await context.route(`**/api/analyze/${runId}`,r=>r.fulfill({json:{runId,track:'design',state:'complete',stage:3,result,answers}}));
  await context.route(`**/api/analyze/${runId}/answers`,r=>{const a=r.request().postDataJSON();answers.push(a);return r.fulfill({json:{ok:true,saved:a.questionId,answers}});});
  await page.goto(`/?run=${runId}`);await page.getByRole('button',{name:'준비 완료'}).click();await page.getByRole('textbox',{name:'답변',exact:true}).fill('저장된 첫 답변');
  await page.getByRole('button',{name:'제출하고 다음',exact:true}).click();await expect(page.getByText('Q2 / 6',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'답변',exact:true}).fill('아직 제출하지 않은 초안');await page.reload();
  await expect(page.getByText('Q2 / 6',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'답변',exact:true})).toHaveValue('아직 제출하지 않은 초안');expect(answers).toHaveLength(1);
});

test('coding UI displays one stored question without its source-code evidence',async({page,context})=>{
  await member(context);const result=fixture(6);for(const q of result.questions){q.pages=[];q.quotes=['export function syntheticEvidence() { return "private-source"; }'];q.notes=['내부 코드 추출 안내'];}
  await context.route('**/api/analyze/code',r=>{expect(r.request().postDataJSON()).toEqual({url:'https://github.com/owner/repo',maxQuestions:10});return r.fulfill({json:{runId}});});
  await context.route(`**/api/analyze/${runId}`,r=>r.fulfill({json:{runId,track:'coding',state:'complete',result,answers:[]}}));
  await page.goto('/');await page.getByRole('button',{name:'개발자',exact:true}).click();await page.getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.getByText('README와 소스 최대 8개를 읽어요.',{exact:true})).toBeVisible();
  await expect(page.getByText(/검토|검수|근거가 부족/)).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);await page.getByRole('textbox',{name:'포트폴리오 링크'}).fill('https://github.com/owner/repo');
  await page.getByRole('button',{name:'AI 분석 시작'}).click();await expect(page.getByRole('heading',{name:'질문 6개, 각 40초예요'})).toBeVisible();
  await page.getByRole('button',{name:'준비 완료'}).click();
  await expect(page.locator('.question-layout h3')).toHaveText(result.questions[0].prompt);
  await expect(page.locator('blockquote, pre, .question-originals')).toHaveCount(0);
  await expect(page.getByText(/syntheticEvidence|내부 코드 추출 안내/)).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'답변',exact:true})).toBeVisible();
});

test('real APIs reject invalid input, cross-origin, anonymous and old guest access without models',async({request,context})=>{
  const multipart={file:upload,track:'design',maxQuestions:'10'};
  expect((await request.post('/api/analyze',{multipart:{...multipart,file:{...upload,buffer:Buffer.from('%P')}}})).status()).toBe(400);
  for(const maxQuestions of ['0','5','11'])expect((await request.post('/api/analyze',{multipart:{...multipart,maxQuestions}})).status()).toBe(400);
  expect((await request.post('/api/analyze',{multipart,headers:{origin:'https://example.invalid'}})).status()).toBe(403);
  expect((await request.post('/api/analyze',{multipart})).status()).toBe(503);
  await context.addCookies([{name:'proofolio_session',value:'x'.repeat(43),url:'http://127.0.0.1:3101'}]);
  expect((await context.request.get(`/api/analyze/${runId}`)).status()).toBe(503);
  expect((await request.post('/api/auth',{data:null})).status()).toBe(400);
});

for(const mode of ['zero','failed'] as const)test(`${mode}: no questions can start`,async({page,context})=>{
  await member(context);await context.route(`**/api/analyze/${runId}`,r=>r.fulfill({json:{runId,track:'design',state:mode==='zero'?'complete':'failed',error:'합성 분석 실패',result:fixture(0)}}));
  await page.goto(`/?run=${runId}`);await expect(page.locator('.error-box[role="alert"]')).toContainText(mode==='zero'?'생성된 질문이 없어요':'합성 분석 실패');
  await expect(page.getByRole('button',{name:'준비 완료'})).toHaveCount(0);
});
