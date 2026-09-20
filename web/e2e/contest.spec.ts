import { test, expect } from '@playwright/test';
import { runId, result } from './recruiting-fixtures';
import type { AnswerRecord } from '../lib/types';

test.beforeEach(async({context})=>{
  // Flow regressions use the CSS fallback font, not an external CDN's availability.
  await context.route('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css',
    r=>r.fulfill({contentType:'text/css',body:''}));
});

test('contest: no identity form, real anonymous cookie, upload to six saved answers, retry and reload',async({page,context},info)=>{
  const answers:AnswerRecord[]=[],attempts:AnswerRecord[]=[],errors:string[]=[];
  let uploads=0,authRequests=0;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&!m.text().includes('503 (Service Unavailable)'))errors.push(m.text());});
  await context.route('**/api/auth',r=>{authRequests++;return r.abort();});
  await context.route('**/api/analyze',r=>{uploads++;expect(r.request().postData()).not.toContain('submissionId');return r.fulfill({json:{runId}});});
  await context.route('**/api/analyze/'+runId,r=>r.fulfill({json:{runId,track:'design',state:'complete',result,answers}}));
  await context.route('**/api/analyze/'+runId+'/answers',r=>{
    const a=r.request().postDataJSON() as AnswerRecord;attempts.push(a);
    if(attempts.length===1)return r.fulfill({status:503,json:{error:'합성 저장 실패'}});
    if(!answers.some(old=>old.questionId===a.questionId))answers.push(a);
    return r.fulfill({json:{ok:true,saved:a.questionId,answers,storage:'supabase'}});
  });
  await page.goto('/?login=1&recovery=1&auth_error=1');await expect(page).toHaveTitle('Proofolio');
  await expect(page.getByRole('heading',{name:'어떤 직무로 검증받을까요?'})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/인증 링크를 확인하지 못했어요/)).toHaveCount(0);
  await expect(page.locator('input[type=email], input[type=password], input[type=tel], input[type=date]')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'채용 대시보드'})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'관리자 데모'})).toBeVisible();
  await expect(page.getByRole('link',{name:'코드로 응시'})).toHaveCount(0);
  const cookie=(await context.cookies()).find(c=>c.name==='proofolio_session')!;
  expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe('Lax');expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(()=>document.cookie)).not.toContain('proofolio_session');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('guest-entry.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'디자이너',exact:true}).click();await page.getByRole('button',{name:'다음',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nSYNTHETIC')});
  await page.getByRole('button',{name:'AI 분석 시작'}).click();await expect(page.getByRole('heading',{name:'질문 6개, 각 40초예요'})).toBeVisible();
  await page.getByRole('button',{name:'준비 완료'}).click();
  for(let i=0;i<6;i++){
    await page.getByRole('textbox',{name:'답변',exact:true}).fill('비회원 합성 답변 '+(i+1));
    if(i===1){await page.reload();await expect(page.getByRole('textbox',{name:'답변',exact:true})).toHaveValue('비회원 합성 답변 2');}
    await page.getByRole('button',{name:i===5?'제출하고 완료':'제출하고 다음',exact:true}).click();
    if(i===0){await expect(page.locator('.error-box[role=alert]')).toContainText('합성 저장 실패');await page.getByRole('button',{name:'답변 저장 재시도'}).click();}
  }
  await expect(page.getByRole('heading',{name:'저장 완료',exact:true})).toBeVisible();
  expect(answers).toHaveLength(6);expect(attempts[1]).toEqual(attempts[0]);expect(uploads).toBe(1);expect(authRequests).toBe(0);expect(errors).toEqual([]);
  expect((await context.cookies()).find(c=>c.name==='proofolio_session')?.value).toBe(cookie.value);
  await expect(page.locator('nextjs-portal [data-nextjs-dialog-overlay]')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('guest-saved.png'),fullPage:true,animations:'disabled'});
});

test('contest real endpoints isolate cookie jars, reject missing sessions, disable account/recruiting writes and paid execution',async({browser,request})=>{
  const a=await browser.newContext(),b=await browser.newContext();
  try {
    const url='http://127.0.0.1:3101';
    expect((await request.get('/api/runs')).status()).toBe(401);
    expect((await request.post('/api/session',{headers:{origin:'https://other.invalid'}})).status()).toBe(403);
    const first=await a.request.post(url+'/api/session');expect(await first.json()).toEqual({ready:true});
    await b.request.post(url+'/api/session');
    const token=(await a.cookies())[0].value;expect((await b.cookies())[0].value).not.toBe(token);
    await a.request.post(url+'/api/session');expect((await a.cookies())[0].value).toBe(token);
    for(const path of ['/api/admin/tests','/api/candidate/submissions/'+runId])expect((await a.request.get(url+path)).status()).toBe(404);
    for(const path of ['/api/auth','/api/candidate/join','/api/candidate/code','/api/admin/tests'])expect((await a.request.post(url+path,{data:{name:'must not store',email:'synthetic@example.com'}})).status()).toBe(404);
    expect((await a.request.get(url+'/api/analyze/'+runId)).status()).toBe(404);
    const upload={file:{name:'test.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-test')},track:'design',maxQuestions:'10'};
    expect((await a.request.post(url+'/api/analyze',{multipart:{...upload,maxQuestions:'11'}})).status()).toBe(400);
    // Zero budget/local storage is intentional. Auth succeeds but no worker may start.
    expect((await a.request.post(url+'/api/analyze',{multipart:upload})).status()).toBe(503);
    expect((await a.request.post(url+'/api/analyze',{multipart:{...upload,submissionId:runId}})).status()).toBe(403);
    expect((await a.request.patch(url+'/api/analyze/'+runId+'/answers',{data:{},headers:{origin:'https://other.invalid'}})).status()).toBe(403);
  } finally {await a.close();await b.close();}
});

test('contest direct navigation cannot reach login or personal-info recruitment forms; examples remain distinct',async({page,context})=>{
  for(const path of ['/test','/tests/'+runId,'/tests/'+runId+'/submissions/'+runId]){
    expect((await page.goto(path))?.status()).toBe(404);await expect(page.locator('input')).toHaveCount(0);
  }
  await page.goto('/login');await expect(page).toHaveURL('http://127.0.0.1:3101/');await expect(page.getByRole('dialog')).toHaveCount(0);
  await context.route('**/api/examples/design',r=>r.fulfill({json:{title:'기존 예제',notice:'기존 결과 재사용',result}}));
  await page.getByRole('button',{name:'예제 체험',exact:true}).click();await page.getByRole('button',{name:'디자이너',exact:true}).click();await page.getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.getByRole('heading',{name:'질문 6개, 각 40초예요'})).toBeVisible();await expect(page.getByText(/기존 생성 결과 6개를 체험해요/)).toBeVisible();
});

test('contest public dashboard reads only curated examples, shows full cards and handles failures',async({page,context},info)=>{
  const unexpected:string[]=[],errors:string[]=[];
  let failed=true;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&!m.text().includes('503 (Service Unavailable)'))errors.push(m.text());});
  await context.route('**/api/**',r=>{
    const path=new URL(r.request().url()).pathname;
    if(!/^\/api\/examples\/(design|marketing|coding)$/.test(path)){unexpected.push(path);return r.abort();}
    expect(r.request().method()).toBe('GET');
    if(failed)return r.fulfill({status:503,json:{error:'합성 예제 연결 실패'}});
    const label=path.endsWith('design')?'디자인':path.endsWith('marketing')?'마케팅':'코딩';
    const count=label==='마케팅'?9:7;
    return r.fulfill({json:{title:label+' 저장 예제',notice:'기존 자동 결과 재사용',result:{...result,
      questions:Array.from({length:count},(_,i)=>({...result.questions[0],id:'q'+i,prompt:`${label} 질문 ${i+1}`}))}}});
  });
  expect((await page.goto('/dashboard'))?.status()).toBe(200);
  await expect(page).toHaveTitle('Proofolio');
  await expect(page.getByRole('heading',{name:'관리자 데모',exact:true})).toBeVisible();
  await expect(page.locator('.error-box[role=alert]')).toContainText('합성 예제 연결 실패');
  failed=false;await page.getByRole('button',{name:'새로고침',exact:true}).click();
  await expect(page.getByRole('region',{name:'예제 목록'}).locator('article')).toHaveCount(3);await expect(page.getByText('23개',{exact:true})).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);await expect(page.getByRole('link',{name:'코드로 응시'})).toHaveCount(0);
  for(const [label,count] of [['디자인',7],['마케팅',9],['코딩',7]] as const){
    const box=await page.getByRole('button',{name:label+' 예제 질문 보기'}).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.getByRole('button',{name:label+' 예제 질문 보기'}).click();
    const detail=page.getByRole('region',{name:label+' 예제 상세'});
    await expect(detail.locator('article')).toHaveCount(count);await expect(detail.getByRole('heading',{name:`1. ${label} 질문 1`,exact:true})).toBeVisible();
    await detail.locator('summary').first().click();await expect(detail.locator('details[open]')).toHaveCount(1);
  }
  expect(unexpected).toEqual([]);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('nextjs-portal [data-nextjs-dialog-overlay]')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('public-dashboard.png'),fullPage:true,animations:'disabled'});
  await context.unroute('**/api/**');
  await page.getByRole('link',{name:'예제 체험하기'}).click();await expect(page).toHaveURL(/\/\?demo=1$/);
});
