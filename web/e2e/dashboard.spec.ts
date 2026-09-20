import { test, expect } from "@playwright/test";

const upload = { name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nsynthetic UI fixture") };
const pad = (n: number) => String(n).padStart(2, "0");
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 실제 서버와 임시 JSON 저장소(PROOFOLIO_STORE_DIR)로 담당자 → 응시자 → 담당자 왕복을 검사한다.
test.describe("recruiter dashboard", () => {
  test.skip(({ isMobile }) => isMobile === true, "desktop only");

  test("login, open a test, candidate submits, results appear, API guards hold", async ({ page, browser, request }, testInfo) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("비밀번호").fill("wrong-password");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?error=1$/);
    await expect(page.locator('.error-box[role="alert"]')).toHaveText("비밀번호가 맞지 않아요.");
    await page.getByLabel("비밀번호").fill("e2e-password");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3101/");
    await expect(page.getByRole("heading", { name: "채용 테스트", exact: true })).toBeVisible();

    const title = `E2E 테스트 ${Date.now()}`;
    await page.getByLabel("제목").fill(title);
    await page.getByLabel("시작").fill(local(new Date(Date.now() - 3_600_000)));
    await page.getByLabel("종료").fill(local(new Date(Date.now() + 3_600_000)));
    await page.getByRole("button", { name: "테스트 열기", exact: true }).click();
    const notice = page.locator(".notice-box");
    await expect(notice).toContainText(title);
    const code = (await notice.locator(".code-pill").textContent())!.trim();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const row = page.locator("table.table tbody tr", { hasText: code });
    await expect(row).toContainText("진행 중");
    await expect(row).toContainText("0 / 0");
    await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true, animations: "disabled" });

    // 응시자는 로그인 쿠키가 없는 별도 컨텍스트에서 참여한다.
    const candidate = await browser.newContext({ baseURL: "http://127.0.0.1:3101" });
    const cp = await candidate.newPage();
    await cp.goto("/test?fast=1");
    await cp.getByLabel("참여 코드").fill(code.toLowerCase());
    await cp.getByRole("button", { name: "다음", exact: true }).click();
    await expect(cp.getByRole("heading", { name: "응시자 정보를 입력해주세요" })).toBeVisible();
    await cp.getByLabel("이름").fill("홍길동");
    await cp.getByLabel("생년월일").fill("1999-02-28");
    await cp.getByLabel("전화번호").fill("010-1234-5678");
    await cp.getByRole("button", { name: "시작하기", exact: true }).click();
    await cp.getByRole("button", { name: "디자이너", exact: true }).click();
    await cp.getByRole("button", { name: "다음", exact: true }).click();
    await cp.locator("input[type=file]").setInputFiles(upload);
    await cp.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
    await expect(cp.getByRole("heading", { name: "질문 5개, 각 40초예요" })).toBeVisible({ timeout: 15_000 });
    await cp.getByRole("button", { name: "준비 완료", exact: true }).click();
    const savedResponse = cp.waitForResponse(r => r.url().includes("/api/candidate/submissions/") && r.request().method() === "POST");
    for (let i = 0; i < 5; i++) {
      await expect(cp.getByRole("textbox", { name: "답변", exact: true })).toBeVisible();
      await cp.getByRole("textbox", { name: "답변", exact: true }).fill(`응시 답변 ${i + 1}`);
      await cp.getByRole("button", { name: i === 4 ? "제출하고 완료" : "제출하고 다음", exact: true }).click();
    }
    await expect(cp.getByRole("heading", { name: "완료되었습니다", exact: true })).toBeVisible();
    expect((await savedResponse).status()).toBe(200);
    await expect(cp.locator('.error-box[role="alert"]')).toHaveCount(0);
    await candidate.close();

    await page.reload();
    await expect(row).toContainText("1 / 1");
    await row.getByRole("link", { name: "보기", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const subRow = page.locator("table.table tbody tr", { hasText: "홍길동" });
    await expect(subRow).toContainText("1999-02-28");
    await expect(subRow).toContainText("010-1234-5678");
    await expect(subRow).toContainText("디자이너");
    await expect(subRow).toContainText("제출 완료");
    await expect(subRow).toContainText("5 / 5");
    await subRow.getByRole("link", { name: "상세", exact: true }).click();
    await expect(page.getByRole("heading", { name: "홍길동", exact: true })).toBeVisible();
    await expect(page.locator(".qa-item")).toHaveCount(5);
    await expect(page.locator(".qa-answer").first()).toHaveText("응시 답변 1");
    await page.screenshot({ path: testInfo.outputPath("submission.png"), fullPage: true, animations: "disabled" });

    // API 가드: 담당자 API는 쿠키 없이 401, 교차 출처 403. 응시자 코드 검사는 친절한 오류.
    const body = { title: "guard", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() };
    expect((await request.post("/api/admin/tests", { data: body })).status()).toBe(401);
    expect((await request.post("/api/admin/tests", { data: body, headers: { origin: "https://example.invalid" } })).status()).toBe(403);
    const unknown = await request.post("/api/candidate/code", { data: { code: "ZZZZZZ" } });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toContain("찾을 수 없어요");
    const upcoming = await page.request.post("/api/admin/tests", { data: { title: "미래", startsAt: "2030-01-01T00:00:00Z", endsAt: "2030-01-02T00:00:00Z" } });
    expect(upcoming.status()).toBe(201);
    const early = await request.post("/api/candidate/code", { data: { code: (await upcoming.json()).test.code } });
    expect(early.status()).toBe(403);
    expect((await early.json()).error).toContain("아직 시작 전");
    expect((await request.get("/tests/00000000-0000-4000-8000-000000000000", { maxRedirects: 0 })).status()).toBe(307);

    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
