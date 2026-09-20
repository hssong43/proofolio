import { test, expect } from "@playwright/test";
import { ROLE_DATA } from "../lib/data";
import type { CompletionPayload, PublicTest } from "../lib/types";

const upload = { name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nsynthetic UI fixture") };
const submissionId = "00000000-0000-4000-8000-000000000002";
const publicTest: PublicTest = {
  testId: "00000000-0000-4000-8000-000000000003", title: "합성 채용 테스트", mode: "demo", totalSeconds: 40, questionCount: 5,
  startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
};

// 응시자 흐름의 UI 연결만 검사한다. API는 스텁이며 분석 품질과 무관하다.
test("candidate: code, info, demo analysis, answers are posted to the submission", async ({ page, context }, testInfo) => {
  const problems: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) problems.push(message.text()); });
  let codeChecks = 0, joins = 0;
  let saved: CompletionPayload | undefined;
  await context.route("**/api/candidate/code", async route => {
    codeChecks++;
    expect(route.request().postDataJSON()).toEqual({ code: "ABC234" });
    await route.fulfill({ json: publicTest });
  });
  await context.route("**/api/candidate/join", async route => {
    joins++;
    expect(route.request().postDataJSON()).toEqual({ code: "ABC234", name: "홍길동", birthDate: "1999-02-28", phone: "010-1234-5678" });
    await route.fulfill({ json: { submissionId, test: publicTest } });
  });
  await context.route(`**/api/candidate/submissions/${submissionId}/answers`, async route => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/test?fast=1");
  await expect(page.getByRole("heading", { name: "참여 코드를 입력해주세요" })).toBeVisible();
  await expect(page.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await page.getByLabel("참여 코드").fill("abc-234");
  await expect(page.getByLabel("참여 코드")).toHaveValue("ABC234");
  await page.getByRole("button", { name: "다음", exact: true }).click();

  await expect(page.getByRole("heading", { name: "응시자 정보를 입력해주세요" })).toBeVisible();
  await expect(page.getByText("합성 채용 테스트", { exact: false })).toBeVisible();
  await page.getByLabel("이름").fill("홍길동");
  await page.getByLabel("생년월일").fill("2001-02-30");
  await page.getByLabel("전화번호").fill("010-1234-5678");
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(page.locator('.error-box[role="alert"]')).toContainText("생년월일");
  await page.getByLabel("생년월일").fill("1999-02-28");
  await page.getByRole("button", { name: "시작하기", exact: true }).click();

  await expect(page.getByRole("heading", { name: "어떤 직무로 검증받을까요?" })).toBeVisible();
  await expect(page.getByText("홍길동", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /개발자/ })).toBeEnabled();
  await page.getByRole("button", { name: "개발자", exact: true }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles(upload);
  await page.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
  await expect(page.getByRole("heading", { name: "질문 5개, 각 40초예요" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "준비 완료", exact: true }).click();

  const questions = ROLE_DATA.dev.questions;
  for (const [i, q] of questions.entries()) {
    await expect(page.getByRole("heading", { level: 3, name: q.text, exact: true })).toBeVisible();
    await expect(page.locator("blockquote")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (i === 0) await page.screenshot({ path: testInfo.outputPath("candidate-question.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("textbox", { name: "답변", exact: true }).fill(`응시 답변 ${i + 1}`);
    await page.getByRole("button", { name: i === questions.length - 1 ? "제출하고 완료" : "제출하고 다음", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "완료되었습니다", exact: true })).toBeVisible();
  await expect.poll(() => saved).toEqual({
    role: "dev", roleLabel: "개발자", runId: null, elapsedSeconds: expect.any(Number),
    questions: questions.map((q, i) => ({ id: `demo-q${i + 1}`, prompt: q.text, quotes: [], notes: [], source: `포트폴리오의 ${q.project} 프로젝트 기반` })),
    answers: questions.map((_, i) => ({ questionId: `demo-q${i + 1}`, answer: `응시 답변 ${i + 1}`, seconds: expect.any(Number) })),
  });
  expect(codeChecks).toBe(1);
  expect(joins).toBe(1);
  expect(problems).toEqual([]);
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
});

test("candidate: unknown code shows the server message", async ({ page, context }) => {
  await context.route("**/api/candidate/code", route => route.fulfill({ status: 404, json: { error: "코드를 찾을 수 없어요. 다시 확인해주세요." } }));
  await page.goto("/test");
  await page.getByLabel("참여 코드").fill("ZZZZZZ");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator('.error-box[role="alert"]')).toHaveText("코드를 찾을 수 없어요. 다시 확인해주세요.");
  await expect(page.getByRole("heading", { name: "참여 코드를 입력해주세요" })).toBeVisible();
});
