import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
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
  await expect(page.getByRole('link',{name:'관리자 패널'})).toBeVisible();
  await expect(page.getByRole('button',{name:'이 브라우저의 기록',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'내 기록',exact:true})).toBeVisible();
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

test('contest direct navigation blocks identity forms; failed example retries only the saved example',async({page,context,request})=>{
  const missingConfig=await request.get('/api/examples/design');
  expect(missingConfig.status()).toBe(503);
  expect(missingConfig.headers()['cache-control']).toBe('no-store');
  expect(await missingConfig.json()).toEqual({error:'예제 서버 연결 설정이 필요해요. 운영자가 배포 환경의 Supabase 설정을 확인해야 해요.',code:'EXAMPLE_CONFIGURATION_ERROR'});
  for(const path of ['/test','/tests/'+runId,'/tests/'+runId+'/submissions/'+runId]){
    expect((await page.goto(path))?.status()).toBe(404);await expect(page.locator('input')).toHaveCount(0);
  }
  await page.goto('/login');await expect(page).toHaveURL('http://127.0.0.1:3101/');await expect(page.getByRole('dialog')).toHaveCount(0);
  let reads=0;const unexpected:string[]=[];
  await context.route('**/api/analyze**',r=>{unexpected.push(r.request().url());return r.abort();});
  await context.route('**/api/examples/design',r=>++reads===1
    ?r.fulfill({status:503,json:{error:'저장된 예제를 불러오지 못했어요. 잠시 후 다시 시도해주세요.'}})
    :r.fulfill({json:{title:'기존 예제',notice:'기존 결과 재사용',result}}));
  await page.getByRole('button',{name:'예제 체험',exact:true}).click();await page.getByRole('button',{name:'디자이너',exact:true}).click();await page.getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.getByRole('heading',{name:'예제를 불러오지 못했어요',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'예제 다시 불러오기',exact:true}).click();
  await expect(page.getByRole('heading',{name:'질문 6개, 각 40초예요'})).toBeVisible();await expect(page.getByText(/기존 생성 결과 6개를 체험해요/)).toBeVisible();
  expect(reads).toBe(2);expect(unexpected).toEqual([]);
});

test('contest applicant dashboard shows curated portfolios and authored answers, never real visitors',async({page,context},info)=>{
  const unexpected:string[]=[],errors:string[]=[];
  const pdf=await PDFDocument.create();
  for(let i=0;i<result.pageCount;i++)pdf.addPage([400,300]);
  const pdfBytes=Buffer.from(await pdf.save());
  let failed=true;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&!m.text().includes('503 (Service Unavailable)'))errors.push(m.text());});
  await context.route('**/api/**',r=>{
    const path=new URL(r.request().url()).pathname;
    if(/^\/api\/examples\/(design|marketing)\/portfolio$/.test(path))return r.fulfill({contentType:'application/pdf',body:pdfBytes});
    if(/^\/api\/examples\/(design|marketing)\/image$/.test(path))return r.fulfill({contentType:'image/png',
      body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=','base64')});
    if(!/^\/api\/examples\/(design|marketing|coding)$/.test(path)){unexpected.push(path);return r.abort();}
    expect(r.request().method()).toBe('GET');
    if(failed)return r.fulfill({status:503,json:{error:'합성 예제 연결 실패'}});
    const label=path.endsWith('design')?'디자인':path.endsWith('marketing')?'마케팅':'코딩';
    const count=label==='마케팅'?9:7;
    const questions=Array.from({length:count},(_,i)=>({...result.questions[0],id:'q'+i,prompt:`${label} 질문 ${i+1}`,pages:label==='코딩'?[]:[i%2+1]}));
    return r.fulfill({json:{title:label+' 저장 예제',notice:'검토 권장 항목이 남아 있어요.',result:{...result,
      questions},images:label==='코딩'?[]:[1,2].map(page=>({page,url:path+'/image?page='+page})),
      portfolioUrl:label==='코딩'?null:path+'/portfolio',
      sampleAnswers:questions.map(q=>({questionId:q.id,answer:`${label} 합성 예시 답변 ${q.id}`}))}});
  });
  expect((await page.goto('/dashboard'))?.status()).toBe(200);
  await expect(page).toHaveTitle('Proofolio');
  await expect(page.getByRole('heading',{name:'응시자 관리',exact:true})).toBeVisible();
  await expect(page.locator('.error-box[role=alert]')).toContainText('합성 예제 연결 실패');
  failed=false;await page.getByRole('button',{name:'새로고침',exact:true}).click();
  await expect(page.getByRole('region',{name:'응시자 목록'}).locator('tbody tr')).toHaveCount(3);
  await expect(page.getByText('23개',{exact:true})).toHaveCount(2);
  await expect(page.locator('input')).toHaveCount(0);await expect(page.getByRole('link',{name:'코드로 응시'})).toHaveCount(0);
  for(const [candidate,label,count] of [['응시자 1','디자인',7],['응시자 2','마케팅',9],['응시자 3','코딩',7]] as const){
    const box=await page.getByRole('button',{name:candidate+' 질문·답변 보기'}).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.getByRole('button',{name:candidate+' 포트폴리오 보기'}).click();
    const detail=page.getByRole('region',{name:candidate+' 상세'});
    if(label==='코딩')await expect(detail.getByRole('link',{name:'GitHub 포트폴리오 열기'})).toHaveAttribute('href','https://github.com/hssong43/proofolio');
    else {
      const portfolioPath='/api/examples/'+(label==='디자인'?'design':'marketing')+'/portfolio';
      await expect(detail.getByText('전체 포트폴리오 · 6페이지',{exact:true})).toBeVisible();
      await expect(detail.locator('object[type="application/pdf"]')).toHaveAttribute('data',portfolioPath+'?retry=0#view=FitH');
      await expect(detail.getByRole('link',{name:'전체 PDF 새 탭으로 열기'})).toHaveAttribute('href',portfolioPath+'?retry=0');
      await expect(detail.getByRole('img')).toHaveCount(0);
      await detail.getByRole('button',{name:'PDF 다시 불러오기'}).click();
      await expect(detail.locator('object')).toHaveAttribute('data',portfolioPath+'?retry=1#view=FitH');
    }
    await detail.getByRole('button',{name:'질문·답변 보기',exact:true}).click();
    await expect(detail.locator('article')).toHaveCount(count);await expect(detail.getByRole('heading',{name:`1. ${label} 질문 1`,exact:true})).toBeVisible();
    await expect(detail.locator('.qa-answer').first()).toHaveText(label+' 합성 예시 답변 q0');
    await expect(detail.locator('object')).toHaveCount(0);
    await expect(detail.locator('blockquote, pre')).toHaveCount(0);
    if(label==='코딩')await expect(detail.locator('.portfolio-thumbnail')).toHaveCount(0);
    else {
      for(let i=0;i<count;i++){
        const card=detail.locator('article').nth(i),pageNumber=i%2+1;
        await expect(card.getByRole('img')).toHaveCount(1);
        await expect(card.getByRole('img')).toHaveAttribute('alt',`${candidate} 원본 포트폴리오 ${pageNumber}페이지`);
        await expect(card.getByRole('link',{name:`${candidate} 포트폴리오 ${pageNumber}페이지 크게 보기`})).toHaveAttribute('href',new RegExp('/image\\?page='+pageNumber+'&retry=0$'));
        expect(await card.evaluate(el=>{
          const source=el.querySelector('.question-thumbnails')!,question=el.querySelector('h3')!,answer=el.querySelector('.qa-answer')!;
          return !!(source.compareDocumentPosition(question)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(question.compareDocumentPosition(answer)&Node.DOCUMENT_POSITION_FOLLOWING);
        })).toBe(true);
      }
      const firstImage=detail.locator('article').first().getByRole('img');
      await expect(firstImage).toBeVisible();await expect.poll(()=>firstImage.evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(1);
    }
    await expect(detail.getByText(/실제 포트폴리오 작성자의 답변이 아니에요/)).toBeVisible();
    await detail.locator('summary').first().click();await expect(detail.locator('details[open]')).toHaveCount(1);
    await expect(page.getByText(/검토 권장|선정한 핵심 포인트/)).toHaveCount(0);
  }
  expect(unexpected).toEqual([]);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('nextjs-portal [data-nextjs-dialog-overlay]')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('public-dashboard.png'),fullPage:true,animations:'disabled'});
  await context.unroute('**/api/**');
  await page.getByRole('link',{name:'응시 화면으로'}).click();await expect(page).toHaveURL(/\/\?demo=1$/);
});
