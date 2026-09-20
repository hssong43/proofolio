import {test,expect} from '@playwright/test';
import {testRecord,testId,submissionId,submission,runId,result} from './recruiting-fixtures';

test('dashboard: real-contract test creation, applicant list and canonical question/answer UI',async({page,context},testInfo)=>{
  let created=false;const problems:string[]=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))problems.push(m.text());});
  await context.route('**/api/admin/tests',r=>{
    if(r.request().method()==='POST'){const body=r.request().postDataJSON();expect(body).toMatchObject({title:testRecord.title,role:'designer',questionCount:10});expect(body.passScore).toBeUndefined();created=true;return r.fulfill({json:{test:testRecord}});}
    return r.fulfill({json:{tests:created?[testRecord]:[]}});
  });
  await context.route('**/api/admin/tests/'+testId,r=>r.fulfill({json:{test:testRecord,submissions:[{...submission,state:'completed',completedAt:new Date().toISOString(),runId}]}}));
  await context.route('**/api/admin/tests/'+testId+'/submissions/'+submissionId,r=>r.fulfill({json:{test:testRecord,submission:{...submission,state:'completed',completedAt:new Date().toISOString(),runId},
    run:{runId,state:'complete',track:'design',result,answers:result.questions.map(q=>({questionId:q.id,answer:'저장된 합성 답변 '+q.id,seconds:3}))}}}));
  await page.goto('/dashboard');await expect(page).toHaveTitle('Proofolio');
  await expect(page.getByRole('heading',{name:'채용 테스트',exact:true})).toBeVisible();
  await expect(page.getByText(/근거가 부족|검토|검수|자동 평가|자동 채점|합불/)).toHaveCount(0);
  await expect(page.getByText('응시 정보는 30일 보관하며, 원본 PDF·코드는 공유하지 않아요.',{exact:true})).toBeVisible();
  await page.getByLabel('제목',{exact:true}).fill(testRecord.title);
  await expect(page.getByLabel('목표 질문 수')).toHaveValue('10');
  await page.getByRole('button',{name:'테스트 열기',exact:true}).click();
  const row=page.locator('tbody tr',{hasText:testRecord.title});await expect(row).toContainText('ABC234');
  await expect(row).toContainText('1 / 1');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('dashboard.png'),fullPage:true});
  await row.getByRole('link',{name:'보기',exact:true}).click();
  await expect(page.getByRole('heading',{name:testRecord.title,exact:true})).toBeVisible();
  await expect(page.getByText(/자동 평가|미지원|검토|검수/)).toHaveCount(0);
  await expect(page.locator('.card.form-grid').getByText('제출 완료',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('applicants.png'),fullPage:true});
  await page.getByRole('link',{name:'질문·답변 보기'}).click();
  await expect(page.locator('.qa-item')).toHaveCount(6);
  await expect(page.locator('.qa-answer').first()).toHaveText('저장된 합성 답변 q1');
  await expect(page.locator('.qa-eval')).toHaveCount(0);
  await page.locator('summary').first().click();await expect(page.getByText('판단 기준 확인',{exact:true}).first()).toBeVisible();
  await expect(page.locator('nextjs-portal [data-nextjs-dialog-overlay]')).toHaveCount(0);expect(problems).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('submission.png'),fullPage:true});
});

test('new real API guards fail closed with no credentials and reject cross-origin writes',async({request})=>{
  for(const path of ['/api/admin/tests','/api/admin/tests/'+testId,'/api/admin/tests/'+testId+'/submissions/'+submissionId,
    '/api/candidate/submissions/'+submissionId])expect((await request.get(path)).status()).toBe(503);
  expect((await request.post('/api/admin/tests',{data:{},headers:{origin:'https://example.invalid'}})).status()).toBe(403);
  expect((await request.post('/api/candidate/code',{data:{code:'ABC234'},headers:{origin:'https://example.invalid'}})).status()).toBe(403);
  expect((await request.post('/api/admin/signup',{data:{}})).status()).toBe(404);
});
