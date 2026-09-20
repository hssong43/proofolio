import {test,expect} from '@playwright/test';
import {testRecord,testId,submissionId,submission,runId,result,score} from './recruiting-fixtures';

test('dashboard: real-contract test creation, applicant list and canonical question/answer UI',async({page,context},testInfo)=>{
  let created=false;const problems:string[]=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))problems.push(m.text());});
  await context.route('**/api/admin/tests',r=>{
    if(r.request().method()==='POST'){const body=r.request().postDataJSON();expect(body).toMatchObject({title:testRecord.title,role:'designer',questionCount:10});expect(body.passScore).toBeUndefined();created=true;return r.fulfill({json:{test:testRecord}});}
    return r.fulfill({json:{tests:created?[testRecord]:[]}});
  });
  let rescores=0,detailReads=0;
  await context.route('**/api/admin/tests/'+testId,r=>r.fulfill({json:{test:testRecord,submissions:[{...submission,state:'completed',completedAt:new Date().toISOString(),runId,score}]}}));
  await context.route('**/api/admin/tests/'+testId+'/submissions/'+submissionId+'/score',r=>{expect(r.request().method()).toBe('POST');rescores++;return r.fulfill({json:{ok:true,state:'running'}});});
  await context.route('**/api/admin/tests/'+testId+'/submissions/'+submissionId,r=>{detailReads++;
    // 첫 읽기: 채점 완료. 재채점 후: 진행 중 → 폴링 후 다시 완료.
    const current=rescores>0&&detailReads===rescores+1?{...score,state:'running' as const,overallScore:null,items:[]}:score;
    return r.fulfill({json:{test:testRecord,submission:{...submission,state:'completed',completedAt:new Date().toISOString(),runId,score:current},
      run:{runId,state:'complete',track:'design',result,answers:result.questions.map((q,i)=>({questionId:q.id,answer:i===5?'':'저장된 합성 답변 '+q.id,seconds:3}))}}});});
  await page.goto('/dashboard');await expect(page).toHaveTitle('Proofolio');
  await expect(page.getByRole('heading',{name:'채용 테스트',exact:true})).toBeVisible();
  await expect(page.getByText(/근거가 부족|검토|검수/)).toHaveCount(0);
  await expect(page.getByText('합불 판정이 아니에요',{exact:false})).toBeVisible();
  await page.getByLabel('제목',{exact:true}).fill(testRecord.title);
  await expect(page.getByLabel('목표 질문 수')).toHaveValue('10');
  await page.getByRole('button',{name:'테스트 열기',exact:true}).click();
  const row=page.locator('tbody tr',{hasText:testRecord.title});await expect(row).toContainText('ABC234');
  await expect(row).toContainText('1 / 1');
  await expect(row.locator('.score-cell')).toContainText('74점');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('dashboard.png'),fullPage:true});
  await row.getByRole('link',{name:'보기',exact:true}).click();
  await expect(page.getByRole('heading',{name:testRecord.title,exact:true})).toBeVisible();
  await expect(page.getByText(/미지원|검토|검수/)).toHaveCount(0);
  await expect(page.locator('.card.stat-grid').getByText('제출 완료',{exact:true})).toBeVisible();
  await expect(page.locator('.card.stat-grid').getByText('74점',{exact:true})).toBeVisible();
  await expect(page.locator('tbody tr .score-cell').first()).toHaveText('74점');
  await page.screenshot({path:testInfo.outputPath('applicants.png'),fullPage:true});
  await page.getByRole('link',{name:'질문·답변 보기'}).click();
  await expect(page.locator('.qa-item')).toHaveCount(6);
  await expect(page.locator('.qa-item blockquote, .qa-item pre')).toHaveCount(0);
  await expect(page.locator('.qa-answer').first()).toHaveText('저장된 합성 답변 q1');
  // AI 채점: 종합 점수, 문항별 점수·포함/누락·코멘트
  await expect(page.locator('.result-panel .result-score')).toContainText('74');
  await expect(page.locator('.result-panel')).toContainText('anthropic/claude-opus-5');
  await expect(page.locator('.qa-eval')).toHaveCount(6);
  await expect(page.locator('.qa-eval .score-pill').first()).toHaveText('100점');
  await expect(page.locator('.qa-eval').first().locator('.coverage-item[data-covered="true"]')).toHaveCount(2);
  await expect(page.locator('.qa-eval').nth(3).locator('.coverage-item[data-covered="false"]')).toHaveCount(1);
  await expect(page.locator('.qa-eval').nth(3)).toContainText('역할 분담은 빠졌어요');
  await expect(page.locator('.qa-eval').nth(4).locator('.score-pill')).toHaveAttribute('data-level','mid');
  await expect(page.locator('.qa-item').nth(5).locator('.qa-eval .score-pill')).toHaveText('0점');
  await expect(page.locator('.qa-item').nth(5).locator('.qa-eval')).toContainText('답변이 없어요');
  await expect(page.locator('.qa-answer').nth(5)).toHaveAttribute('data-empty','true');
  await page.locator('summary').first().click();await expect(page.getByText('판단 기준 확인',{exact:true}).first()).toBeVisible();
  // 재채점 요청 → 진행 중 배지 → 폴링 후 완료
  await page.getByRole('button',{name:'다시 채점',exact:true}).click();
  await expect(page.locator('.result-panel .badge[data-status="scoring"]')).toBeVisible();
  await expect(page.locator('.result-panel .result-score')).toContainText('74',{timeout:15_000});
  expect(rescores).toBe(1);
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
