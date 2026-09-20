import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, copyFileSync, constants } from "node:fs";
import { resolve, join } from "node:path";
import { Budget } from "../../src/llm.ts";
import { sha256 } from "../../src/pipeline.ts";
import { OPENROUTER_MODELS, OPENROUTER_REQUEST_INTERVAL_MS, OPENROUTER_MAX_RATE_LIMIT_RETRIES } from "../../src/openrouter.ts";
import { checkOpenRouter } from "../../src/check-openrouter.ts";
import { toClientResult } from "../lib/server/runner.ts";
import type { AnswerRecord } from "../lib/types.ts";

// Explicit paid opt-in only. No mocks, E2E retries, parallel documents or regenerated benchmark runs.
test("two PDFs: member login -> real upload -> source-linked questions -> immutable database answers", async ({ browser }, testInfo) => {
  const root = resolve(process.cwd(), ".."), runId = process.env.PROOFOLIO_E2E_RUN!;
  const directory = join(root, "output/benchmark/runs", runId), ledger = join(root, "output/openrouter-budget.jsonl");
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const fresh = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const fingerprint = () => {
    const files = ["src", "web/app", "web/components", "web/lib", "web/e2e"].flatMap(dir =>
      readdirSync(join(root, dir), { recursive: true }).map(String).filter(p => /\.tsx?$/.test(p)).map(p => `${dir}/${p}`));
    files.push("package.json", "package-lock.json", "tsconfig.json", "web/package.json", "web/package-lock.json", "web/tsconfig.json", "web/playwright.paid.config.ts");
    return sha256(files.sort().map(p => p + "\0" + readFileSync(join(root, p), "utf8")).join("\0"));
  };
  expect(existsSync(ledger)).toBe(true);expect(existsSync(ledger + ".lock")).toBe(false);
  const snapshot = () => { const budget = new Budget(ledger, 10, "openrouter"); try { return budget.snapshot(); } finally { budget.close(); } };
  const before = snapshot();expect(before.blocked).toBe(false);expect(before.active_reserved_usd ?? 0).toBe(0);
  const approvedHolds = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(row => row.type === "approved_unknown_cost_hold");
  expect(approvedHolds.length).toBeGreaterThan(0);
  expect(before.unknown_cost_hold_usd).toBe(approvedHolds.reduce((sum, row) => sum + row.usd, 0));
  const access = await checkOpenRouter();
  const hash = fingerprint(), legacyHash = sha256(readFileSync(join(root, "output/benchmark/api-budget.jsonl")));
  const corpus = json(join(root, "benchmark/corpus.json"));
  const selectedDocument = process.env.PROOFOLIO_E2E_DOCUMENT;
  expect(selectedDocument === undefined || ["d-shuu", "m-damyul"].includes(selectedDocument)).toBe(true);
  const documents = [
    { id: "m-damyul", track: "marketing", role: "마케터", viewport: { width: 390, height: 844 }, mobile: true },
    { id: "d-shuu", track: "design", role: "디자이너", viewport: { width: 1440, height: 1000 }, mobile: false },
  ].filter(doc => !selectedDocument || doc.id === selectedDocument);
  for (const doc of documents) expect(sha256(readFileSync(join(root, "output/benchmark/sources", doc.id, "source.pdf"))))
    .toBe(corpus.find((r: { id: string }) => r.id === doc.id).sha256);
  mkdirSync(directory, { mode: 0o700 });
  fresh(join(directory, "run.json"), { phase: "pilot", mode: "real_web_e2e", runId, provider: "openrouter", code_sha256: hash,
    model: OPENROUTER_MODELS.vision, skim_model: OPENROUTER_MODELS.skim, review_model: OPENROUTER_MODELS.vision,
    question_model: OPENROUTER_MODELS.questions, max_questions: 10, started_at: new Date().toISOString(),
    documents: documents.map(d => d.id), sources: corpus.filter((r: { id: string }) => documents.some(d => d.id === r.id)),
    budget_before: before, ledger_sha256_before: sha256(readFileSync(ledger)), access,
    browser: "Browser plugin not available; project Playwright", automatic_test_retries: 0,
    minimum_request_interval_ms: OPENROUTER_REQUEST_INTERVAL_MS,
    max_rate_limit_retries: OPENROUTER_MAX_RATE_LIMIT_RETRIES, provider_fallbacks: true });
  const failures: string[] = [];let stopped = false;
  try {
    for (const doc of documents) {
      const dir = join(directory, doc.id);mkdirSync(dir, { mode: 0o700 });
      if (stopped) { fresh(join(dir, "error.json"), { status: "unattempted_after_failure", budget: snapshot() });continue; }
      const context = await browser.newContext({ viewport: doc.viewport, isMobile: doc.mobile, hasTouch: doc.mobile });
      const page = await context.newPage(), problems: string[] = [], start = Date.now();
      let webRunId: string | undefined;
      page.on("pageerror", e => problems.push(e.message));
      page.on("console", m => { if (["warning", "error"].includes(m.type())) problems.push(m.text()); });
      try {
        expect(fingerprint()).toBe(hash);expect(snapshot().blocked).toBe(false);
        const login=await context.request.post('http://127.0.0.1:3102/api/auth',{data:{action:'signin',
          email:process.env.PROOFOLIO_E2E_EMAIL,password:process.env.PROOFOLIO_E2E_PASSWORD}});
        expect(login.status(),'Confirmed test member login failed; no PDF was submitted.').toBe(200);
        await page.goto("http://127.0.0.1:3102/?seconds=120");
        await expect(page).toHaveTitle("Proofolio");await expect(page).toHaveURL("http://127.0.0.1:3102/?seconds=120");
        await expect(page.getByRole("heading", { name: "어떤 직무로 검증받을까요?" })).toBeVisible();
        await page.getByRole("button", { name: doc.role, exact: true }).click();
        await page.getByRole("button", { name: "다음", exact: true }).click();
        await page.locator("input[type=file]").setInputFiles(join(root, "output/benchmark/sources", doc.id, "source.pdf"));
        const uploaded = page.waitForResponse(r => r.url().endsWith("/api/analyze") && r.request().method() === "POST");
        await page.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
        const response = await uploaded;expect(response.ok()).toBe(true);webRunId = (await response.json()).runId;
        fresh(join(dir, "web-run.json"), { runId: webRunId, viewport: doc.viewport, source_sha256: corpus.find((r: { id: string }) => r.id === doc.id).sha256 });
        console.log(JSON.stringify({ document: doc.id, web_run: webRunId, event: "uploaded" }));
        await expect.poll(() => json(join(root, "output/web/runs", webRunId!, "status.json")).state,
          { timeout: 720_000, intervals: [2000] }).toMatch(/^(complete|failed)$/); // Read-only polling, never re-uploads.
        const status = json(join(root, "output/web/runs", webRunId!, "status.json"));
        expect(status.state, status.error).toBe("complete");
        const raw = json(join(root, "output/web/runs", webRunId!, "result.json")), client = toClientResult(raw);
        expect(client.maxQuestions).toBe(10);expect(client.questions.length).toBeGreaterThan(0);
        await expect(page.getByRole("heading", { name: `질문 ${client.questions.length}개, 각 120초예요` })).toBeVisible();
        if (client.status === "needs_review" || client.questions.length < 6)
          await expect(page.getByText(`목표 6~10개 / 생성 ${client.questions.length}개 · ${client.questions.length<6?'부분 결과':'검토 권장'}`, { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(doc.id + "-ready.png"), fullPage: true, animations: "disabled" });
        await page.getByRole("button", { name: "준비 완료", exact: true }).click();
        const answers: AnswerRecord[] = [];
        for (const [i, q] of client.questions.entries()) {
          const heading = page.getByRole("heading", { level: 3, name: q.prompt, exact: true });
          await expect(heading).toBeVisible();expect(await heading.textContent()).toBe(q.prompt);
          await expect(page.locator("blockquote")).toHaveText(q.quotes);
          await expect(page.getByText(`${q.projectTitle} · ${q.pages.join(", ")}페이지 근거`, { exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (i === 0) await page.screenshot({ path: testInfo.outputPath(doc.id + "-question.png"), fullPage: true, animations: "disabled" });
          const answer = `자동 E2E 저장 확인: ${q.id}. 지원자의 실제 답변이 아닙니다.`;
          answers.push({ questionId: q.id, answer, seconds: 0 });
          await page.getByRole("textbox", { name: "답변", exact: true }).fill(answer);
          await page.getByRole("button", { name: i === client.questions.length - 1 ? "제출하고 완료" : "제출하고 다음", exact: true }).click();
        }
        await expect(page.getByRole("heading", { name: "저장 완료", exact: true })).toBeVisible();
        const savedResponse=await context.request.get(`http://127.0.0.1:3102/api/analyze/${webRunId}`);
        expect(savedResponse.status()).toBe(200);const saved=await savedResponse.json();
        expect(saved.answers.map(({ seconds, ...a }: AnswerRecord) => a)).toEqual(answers.map(({ seconds, ...a }) => a));
        expect(saved.answers.every((a: AnswerRecord) => Number.isSafeInteger(a.seconds) && a.seconds >= 0)).toBe(true);
        expect((await context.request.patch(`http://127.0.0.1:3102/api/analyze/${webRunId}/answers`, { data: saved.answers[0] })).status()).toBe(200);
        expect((await context.request.post(`http://127.0.0.1:3102/api/analyze/${webRunId}/answers`, { data: { answers: [...saved.answers, saved.answers[0]] } })).status()).toBe(400);
        expect((await (await context.request.get(`http://127.0.0.1:3102/api/analyze/${webRunId}`)).json()).answers).toEqual(saved.answers);
        await page.screenshot({ path: testInfo.outputPath(doc.id + "-saved.png"), fullPage: true, animations: "disabled" });
        expect(problems).toEqual([]);await expect(page.locator("nextjs-portal")).toHaveCount(0);
        fresh(join(dir, "completion.json"), { status: "completed", elapsed_ms: Date.now() - start, webRunId, budget: snapshot(),
          ui_checks: { title: true, nonblank: true, no_overlay: true, console: problems, whole_questions_quotes_pages: true, answers_saved: saved.answers.length } });
      } catch (e) {
        const budget = snapshot();failures.push(doc.id + ": " + (e as Error).message);
        fresh(join(dir, "error.json"), { status: "failed", error: (e as Error).message, elapsed_ms: Date.now() - start, budget, webRunId, console: problems });
        stopped = true; // A failed paid run needs an explicit decision, not an automatic re-upload.
      } finally {
        if (webRunId) {
          const from = join(root, "output/web/runs", webRunId);
          for (const name of ["result.json", "questions.txt", "events.jsonl", "stderr.log"])
            if (existsSync(join(from, name))) copyFileSync(join(from, name), join(dir, name), constants.COPYFILE_EXCL);
          if (existsSync(join(from, "raw"))) for (const name of readdirSync(join(from, "raw")).sort()) {
            const row = json(join(from, "raw", name));
            fresh(join(dir, `raw-${name.replace(/\.json$/, "")}-${row.kind}.json`), { ...row.raw, _request_model: row.model, _request_stage: row.kind, _request_provider: "openrouter" });
          }
        }
        await context.close();
      }
    }
  } finally {
    const after = snapshot();fresh(join(directory, "budget-after.json"), after);
    expect(after.unknown_cost_hold_usd).toBe(before.unknown_cost_hold_usd);
    expect(sha256(readFileSync(join(root, "output/benchmark/api-budget.jsonl")))).toBe(legacyHash);
    expect(fingerprint()).toBe(hash);
  }
  expect(failures).toEqual([]);
});
