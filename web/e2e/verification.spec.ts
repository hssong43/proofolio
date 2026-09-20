import { test, expect } from "@playwright/test";
import type { AnswerRecord, ClientResult } from "../lib/types";

const upload = { name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nsynthetic UI fixture") };

// Synthetic data only: this checks UI wiring, not PDF analysis or question quality.
for (const [track, role, count] of [["design", "디자이너", 10], ["marketing", "마케터", 2]] as const) {
  test(`${track}: upload, poll, answer every question`, async ({ page, context }, testInfo) => {
    const problems: string[] = [];
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      if (["error", "warning"].includes(message.type()) && !(track === "marketing" && message.text().includes("500 (Internal Server Error)"))) problems.push(message.text());
    });
    const result: ClientResult = {
      status: track === "marketing" ? "needs_review" : "evidence_ready", qualityIssues: track === "marketing" ? ["selected_points_uncovered"] : [], pageCount: 10,
      projects: [{ key: "demo", title: "합성 테스트 프로젝트", pages: [1, 2, 3, 4, 5] }],
      evidenceCount: count, estimatedCostUsd: 0, maxQuestions: 10,
      questions: Array.from({ length: count }, (_, i) => ({
        id: `q${i + 1}`, prompt: `테스트 질문 ${i + 1}: 이 작업에서 직접 맡은 범위를 설명해 주세요.\n판단 근거도 함께 설명해 주세요.`,
        quotes: [`테스트용 원문 ${i + 1}\n선택 이유를 설명한 예시입니다.`], notes: [], pages: [i + 1],
        projectTitle: "합성 테스트 프로젝트", intent: "UI 연결 검사", listenFor: [], answerTarget: "작업 범위",
      })),
    };
    const runId = "00000000-0000-4000-8000-000000000001";
    let polls = 0, uploads = 0, saves = 0;
    let releaseSave: () => void = () => {};
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    let saved: { answers: AnswerRecord[] } | undefined;
    await context.route("**/api/analyze", async route => {
      uploads++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postData()).toContain('name="maxQuestions"\r\n\r\n10');
      expect(route.request().postData()).toContain(`name="track"\r\n\r\n${track}`);
      await route.fulfill({ json: { runId } });
    });
    await context.route(`**/api/analyze/${runId}`, route => route.fulfill({ json: {
      runId, track, fileName: upload.name, startedAt: new Date().toISOString(),
      state: ++polls === 1 ? "running" : "complete", stage: polls === 1 ? 1 : 3,
      ...(polls > 1 ? { result } : {}),
    } }));
    await context.route(`**/api/analyze/${runId}/answers`, async route => {
      expect(route.request().method()).toBe("POST");
      saved = route.request().postDataJSON();
      if (track === "marketing" && ++saves === 1) { await route.fulfill({ status: 500, json: { error: "합성 저장 실패" } }); return; }
      if (track === "marketing") await saveGate;
      await route.fulfill({ json: { ok: true, saved: count } });
    });

    await page.goto("/");
    await expect(page).toHaveTitle("Proofolio");
    await expect(page).toHaveURL("http://127.0.0.1:3101/");
    await expect(page.getByRole("heading", { name: "어떤 직무로 검증받을까요?" })).toBeVisible();
    await expect(page.getByRole("button", { name: /개발자/ })).toBeDisabled();
    await page.getByRole("button", { name: role, exact: true }).click();
    await expect(page.getByRole("button", { name: role, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "다음", exact: true }).click();
    await page.locator("input[type=file]").setInputFiles(upload);
    await page.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
    await expect(page.getByRole("heading", { name: `질문 ${count}개, 각 40초예요` })).toBeVisible();
    if (track === "marketing") {
      await expect(page.getByText("목표 10개 / 생성 2개 · 부분 결과", { exact: true })).toBeVisible();
      await expect(page.getByText("선정한 핵심 포인트 일부를 충분히 다루지 못했어요.")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("partial-result.png"), fullPage: true, animations: "disabled" });
    }
    await page.getByRole("button", { name: "준비 완료", exact: true }).click();

    for (const [i, question] of result.questions.entries()) {
      const heading = page.getByRole("heading", { level: 3, name: question.prompt, exact: true });
      await expect(heading).toBeVisible();
      expect(await heading.textContent()).toBe(question.prompt);
      await expect(page.locator("blockquote")).toHaveText(question.quotes);
      await expect(page.getByText(`합성 테스트 프로젝트 · ${i + 1}페이지 근거`, { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "답변", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (i === 0) await page.screenshot({ path: testInfo.outputPath("question.png"), fullPage: true, animations: "disabled" });
      await page.getByRole("textbox", { name: "답변", exact: true }).fill(`테스트 답변 ${i + 1}`);
      await page.getByRole("button", { name: i === count - 1 ? "제출하고 완료" : "제출하고 다음", exact: true }).click();
    }
    if (track === "marketing") {
      await expect(page.getByRole("heading", { name: "저장 실패", exact: true })).toBeVisible();
      const first = structuredClone(saved);
      await expect(page.getByRole("button", { name: "홈으로" })).toBeDisabled();
      await page.getByRole("button", { name: "답변 저장 재시도", exact: true }).click();
      await expect(page.getByRole("heading", { name: "저장 중", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "저장 완료", exact: true })).toHaveCount(0);
      await expect.poll(() => saves).toBe(2);expect(saved).toEqual(first);
      releaseSave();
    }
    await expect(page.getByRole("heading", { name: "저장 완료", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("saved.png"), fullPage: true, animations: "disabled" });
    await expect(page.getByText("기업 전송과 자동 평가는 아직 지원하지 않아요.", { exact: false })).toBeVisible();
    await expect.poll(() => saved?.answers).toEqual(result.questions.map((q, i) => ({
      questionId: q.id, answer: `테스트 답변 ${i + 1}`, seconds: expect.any(Number),
    })));
    expect(uploads).toBe(1);
    expect(polls).toBe(2);
    expect(problems).toEqual([]);
    await expect(page.locator("nextjs-portal [data-nextjs-dialog-overlay]")).toHaveCount(0);
  });
}

test("real API rejects invalid PDF, zero budget and cross-origin requests", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "디자이너", exact: true }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({ ...upload, buffer: Buffer.from("%P") });
  const rejected = page.waitForResponse(response => response.url().endsWith("/api/analyze"));
  await page.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await expect(page.locator('.error-box[role="alert"]')).toHaveText("PDF 파일만 올릴 수 있어요.");
  await page.screenshot({ path: testInfo.outputPath("invalid-pdf.png"), animations: "disabled" });

  const multipart = { file: upload, track: "design", maxQuestions: "10" };
  expect((await request.post("/api/analyze", { multipart: { ...multipart, maxQuestions: "11" } })).status()).toBe(400);
  const noBudget = await request.post("/api/analyze", { multipart });
  expect(noBudget.status()).toBe(500);
  expect((await noBudget.json()).error).toContain("승인한 누적 한도");
  const crossOrigin = await request.post("/api/analyze", { multipart, headers: { origin: "https://example.invalid" } });
  expect(crossOrigin.status()).toBe(403);
});

for (const mode of ["zero", "failed"] as const) test(`${mode}: block starting questions`, async ({ page, context }) => {
  const runId = "00000000-0000-4000-8000-000000000002";
  await context.route("**/api/analyze", route => route.fulfill({ json: { runId } }));
  await context.route(`**/api/analyze/${runId}`, route => route.fulfill({ json: {
    runId, state: mode === "failed" ? "failed" : "complete", stage: 3, error: "합성 분석 실패",
    result: { status: "insufficient_evidence", questions: [], projects: [], qualityIssues: [], pageCount: 1, maxQuestions: 10 },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "디자이너", exact: true }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles(upload);
  await page.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
  await expect(page.locator('.error-box[role="alert"]')).toContainText(mode === "failed" ? "합성 분석 실패" : "생성된 질문이 없어요");
  await expect(page.getByRole("button", { name: "준비 완료", exact: true })).toHaveCount(0);
});
