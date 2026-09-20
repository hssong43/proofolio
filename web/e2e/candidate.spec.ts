import {test,expect} from '@playwright/test';
import type {AnswerRecord} from '../lib/types';
import {runId,submissionId,publicTest,result,submission} from './recruiting-fixtures';

test('candidate: main analysis, canonical answers, reload, failed finalization and retry without re-analysis',async({page,context},testInfo)=>{
  const answers:AnswerRecord[]=[],entry={test:publicTest,submission:{...submission}};
  let uploads=0,finalizations=0,links=0,polls=0;
  const problems:string[]=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&!m.text().includes('503 (Service Unavailable)'))problems.push(m.text());});
  await context.route('**/api/auth',r=>r.fulfill({json:{user:{email:'candidate@example.com'},configured:true}}));
  await context.route('**/api/candidate/code',r=>{expect(r.request().postDataJSON()).toEqual({code:'ABC234'});return r.fulfill({json:publicTest});});
  await context.route('**/api/candidate/join',r=>{
    expect(r.request().postDataJSON()).toMatchObject({code:'ABC234',consent:true,name:'합성 응시자'});
    return r.fulfill({json:entry});
  });
  await context.route('**/api/candidate/submissions/'+submissionId,r=>{
    if(r.request().method()==='POST'){links++;expect(r.request().postDataJSON()).toEqual({runId});entry.submission.runId=runId;return r.fulfill({json:{ok:true}});}
    return r.fulfill({json:entry});
  });
  await context.route('**/api/candidate/submissions/'+submissionId+'/answers',r=>{
    finalizations++;expect(r.request().postDataJSON()).toEqual({runId});
    expect(answers).toHaveLength(6);
    return finalizations===1?r.fulfill({status:503,json:{error:'합성 제출 확인 실패'}}):r.fulfill({json:{ok:true,submissionId}});
  });
  await context.route('**/api/analyze',r=>{
    uploads++;expect(r.request().postData()).toContain(submissionId);
    expect(r.request().postData()).toContain('name="maxQuestions"\r\n\r\n10');
    return r.fulfill({json:{runId}});
  });
  await context.route('**/api/analyze/'+runId,r=>r.fulfill({json:{runId,track:'design',state:++polls===1?'running':'complete',stage:1,result,answers}}));
  await context.route('**/api/analyze/'+runId+'/answers',r=>{
    expect(r.request().method()).toBe('PATCH');
    const answer=r.request().postDataJSON() as AnswerRecord;answers.push(answer);
    return r.fulfill({json:{ok:true,saved:answer.questionId,answers}});
  });
  await page.goto('/test');await expect(page).toHaveTitle('Proofolio');
  await page.getByLabel('참여 코드').fill('abc-234');await page.getByRole('button',{name:'다음',exact:true}).click();
  await page.getByLabel('이름',{exact:true}).fill('합성 응시자');
  await page.getByLabel('생년월일').fill('2000-01-01');await page.getByLabel('전화번호').fill('01000000000');
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'시작하기',exact:true}).click();
  await expect(page.getByRole('heading',{name:'지원 직무를 확인해주세요'})).toBeVisible();
  await page.getByRole('button',{name:'아니에요',exact:true}).click();
  await expect(page.getByRole('button',{name:'맞아요, 계속'})).toBeDisabled();
  await page.getByRole('button',{name:'다시 확인',exact:true}).click();await page.getByRole('button',{name:'맞아요, 계속'}).click();
  await page.locator('input[type=file]').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nSYNTHETIC')});
  await page.getByRole('button',{name:'AI 분석 시작'}).click();
  await expect(page.getByRole('heading',{name:'질문 6개, 각 40초예요'})).toBeVisible();
  await page.getByRole('button',{name:'준비 완료'}).click();
  for(const [i,q] of result.questions.entries()){
    await expect(page.getByRole('heading',{name:q.prompt,exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:'답변',exact:true}).fill('응시 답변 '+(i+1));
    if(i===1){await page.reload();await expect(page.getByRole('textbox',{name:'답변',exact:true})).toHaveValue('응시 답변 2');}
    if(i===0)await page.screenshot({path:testInfo.outputPath('candidate-question.png'),fullPage:true});
    await page.getByRole('button',{name:i===5?'제출하고 완료':'제출하고 다음',exact:true}).click();
  }
  await expect(page.getByRole('heading',{name:'저장 실패',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'홈으로',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'제출 확인 재시도'}).click();
  await expect(page.getByRole('heading',{name:'제출 완료',exact:true})).toBeVisible();
  expect(uploads).toBe(1);expect(finalizations).toBe(2);expect(links).toBe(2);
  expect(answers.map(a=>a.questionId)).toEqual(result.questions.map(q=>q.id));
  expect(problems).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('nextjs-portal [data-nextjs-dialog-overlay]')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('candidate-complete.png'),fullPage:true});
});

test('candidate guest uses existing email login; main remains accessible',async({page,context})=>{
  await context.route('**/api/auth',r=>r.fulfill({json:{user:null,configured:true}}));
  await page.goto('/test');
  await expect(page.getByRole('heading',{name:'로그인하고 테스트에 참여하세요'})).toBeVisible();
  await page.getByRole('link',{name:'이메일 로그인',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/login=1/);
  await expect(page.getByRole('link',{name:'로그인 없이 예제 체험'})).toHaveCount(0);
});

test('candidate rejects unknown code without advancing',async({page,context})=>{
  await context.route('**/api/auth',r=>r.fulfill({json:{user:{email:'candidate@example.com'},configured:true}}));
  await context.route('**/api/candidate/code',r=>r.fulfill({status:404,json:{error:'코드가 없거나 응시 기간이 아니에요.'}}));
  await page.goto('/test');await page.getByLabel('참여 코드').fill('ZZZZZZ');await page.getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.locator('.error-box[role="alert"]')).toContainText('응시 기간');await expect(page.getByRole('heading',{name:'참여 코드를 입력해주세요'})).toBeVisible();
});
