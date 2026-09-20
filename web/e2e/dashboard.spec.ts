import { test, expect } from "@playwright/test";

const upload = { name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nsynthetic UI fixture") };
const pad = (n: number) => String(n).padStart(2, "0");
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const STRONG_ANSWER = "이탈률을 38%에서 21%로 줄인 결과는 4주간 A/B 테스트로 측정했습니다. 판단 기준은 퍼널 데이터였고 대안으로 튜토리얼 축소도 비교했습니다. 제가 직접 온보딩 화면을 담당했습니다.";

// 실제 서버와 임시 JSON 저장소(PROOFOLIO_STORE_DIR)로 회원가입 → 테스트 생성 → 응시 → 평가 확인 왕복을 검사한다.
test.describe("recruiter dashboard", () => {
  test.skip(({ isMobile }) => isMobile === true, "desktop only");

  test("sign up, open a role-locked test, candidate submits, evaluation appears, API guards hold", async ({ page, browser, request }, testInfo) => {
    const stamp = Date.now();
    const email = `recruiter+${stamp}@example.com`;
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "채용 담당자 로그인" })).toBeVisible();

    // 회원가입 탭: 비밀번호 확인 불일치 → 오류, 정상 가입 → 대시보드
    await page.getByRole("tab", { name: "회원가입" }).click();
    await expect(page).toHaveURL(/tab=signup/);
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill("e2e-password");
    await page.getByLabel("비밀번호 확인").fill("different");
    await page.getByLabel("이름").fill("김담당");
    await page.getByLabel("회사").fill("프루폴리오");
    await page.getByRole("button", { name: "가입하고 시작하기", exact: true }).click();
    await expect(page.locator('.error-box[role="alert"]')).toHaveText("비밀번호 확인이 일치하지 않아요.");
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill("e2e-password");
    await page.getByLabel("비밀번호 확인").fill("e2e-password");
    await page.getByLabel("이름").fill("김담당");
    await page.getByLabel("회사").fill("프루폴리오");
    await page.getByRole("button", { name: "가입하고 시작하기", exact: true }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3101/");
    await expect(page.getByRole("heading", { name: "채용 테스트", exact: true })).toBeVisible();
    await expect(page.getByText("김담당", { exact: true })).toBeVisible();

    const title = `E2E 테스트 ${stamp}`;
    await page.getByLabel("제목").fill(title);
    await page.getByLabel("직무").selectOption("mkt");
    await page.getByLabel("통과 점수").fill("60");
    await page.getByLabel("시작").fill(local(new Date(Date.now() - 3_600_000)));
    await page.getByLabel("종료").fill(local(new Date(Date.now() + 3_600_000)));
    await page.getByRole("button", { name: "테스트 열기", exact: true }).click();
    const notice = page.locator(".notice-box");
    await expect(notice).toContainText(title);
    await expect(notice).toContainText("마케터");
    const code = (await notice.locator(".code-pill").textContent())!.trim();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const row = page.locator("table.table tbody tr", { hasText: code });
    await expect(row).toContainText("마케터");
    await expect(row).toContainText("진행 중");
    await expect(row).toContainText("0 / 0");
    await expect(row).toContainText("60점 기준");
    await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true, animations: "disabled" });

    // 응시자는 로그인 쿠키가 없는 별도 컨텍스트에서 참여한다. 직무는 확인만 한다.
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
    await expect(cp.getByRole("heading", { name: "지원 직무를 확인해주세요" })).toBeVisible();
    await expect(cp.getByText("마케터", { exact: true }).first()).toBeVisible();
    await cp.getByRole("button", { name: "맞아요, 계속", exact: true }).click();
    await expect(cp.getByRole("heading", { name: "포트폴리오를 올려주세요" })).toBeVisible();
    await cp.locator("input[type=file]").setInputFiles(upload);
    await cp.getByRole("button", { name: "AI 분석 시작", exact: true }).click();
    await expect(cp.getByRole("heading", { name: "질문 10개, 각 40초예요" })).toBeVisible({ timeout: 15_000 });
    await cp.getByRole("button", { name: "준비 완료", exact: true }).click();
    const savedResponse = cp.waitForResponse(r => r.url().includes("/api/candidate/submissions/") && r.request().method() === "POST");
    for (let i = 0; i < 10; i++) {
      await expect(cp.getByRole("textbox", { name: "답변", exact: true })).toBeVisible();
      // 앞 8개는 근거가 충실한 답변, 마지막 2개는 빈 답변 → 평균이 60점 기준을 넘는지 확인한다.
      if (i < 8) await cp.getByRole("textbox", { name: "답변", exact: true }).fill(STRONG_ANSWER);
      await cp.getByRole("button", { name: i === 9 ? "제출하고 완료" : "제출하고 다음", exact: true }).click();
    }
    await expect(cp.getByRole("heading", { name: "완료되었습니다", exact: true })).toBeVisible();
    expect((await savedResponse).status()).toBe(200);
    await expect(cp.locator('.error-box[role="alert"]')).toHaveCount(0);
    await candidate.close();

    await page.reload();
    await expect(row).toContainText("1 / 1");
    await row.getByRole("link", { name: "보기", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("통과 기준 60점", { exact: true })).toBeVisible();
    const subRow = page.locator("table.table tbody tr", { hasText: "홍길동" });
    await expect(subRow).toContainText("1999-02-28");
    await expect(subRow).toContainText("010-1234-5678");
    await expect(subRow).toContainText("제출 완료");
    await expect(subRow).toContainText("8 / 10");
    await expect(subRow).toContainText(/\d+점/);
    await expect(subRow).toContainText("통과");
    await subRow.getByRole("link", { name: "상세", exact: true }).click();
    await expect(page.getByRole("heading", { name: "홍길동", exact: true })).toBeVisible();
    await expect(page.locator(".result-panel")).toContainText("통과 기준 60점");
    await expect(page.locator(".result-panel .badge")).toHaveText("통과");
    await expect(page.locator(".qa-item")).toHaveCount(10);
    await expect(page.locator(".qa-answer").first()).toHaveText(STRONG_ANSWER);
    await expect(page.locator(".qa-eval")).toHaveCount(10);
    await expect(page.locator(".qa-eval").first().locator(".score-pill")).toContainText(/\d+점/);
    await expect(page.locator(".qa-eval").last()).toContainText("0점");
    await expect(page.locator(".qa-eval").last()).toContainText("답변이 없어요");
    await page.screenshot({ path: testInfo.outputPath("submission.png"), fullPage: true, animations: "disabled" });

    // API 가드: 담당자 API는 쿠키 없이 401, 교차 출처 403. 응시자 코드 검사는 친절한 오류.
    const body = { title: "guard", role: "designer", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() };
    expect((await request.post("/api/admin/tests", { data: body })).status()).toBe(401);
    expect((await request.post("/api/admin/tests", { data: body, headers: { origin: "https://example.invalid" } })).status()).toBe(403);
    expect((await page.request.post("/api/admin/tests", { data: { ...body, role: "pilot" } })).status()).toBe(400);
    expect((await page.request.post("/api/admin/tests", { data: { ...body, passScore: 101 } })).status()).toBe(400);
    const unknown = await request.post("/api/candidate/code", { data: { code: "ZZZZZZ" } });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toContain("찾을 수 없어요");
    const upcoming = await page.request.post("/api/admin/tests", { data: { ...body, title: "미래", startsAt: "2030-01-01T00:00:00Z", endsAt: "2030-01-02T00:00:00Z" } });
    expect(upcoming.status()).toBe(201);
    const early = await request.post("/api/candidate/code", { data: { code: (await upcoming.json()).test.code } });
    expect(early.status()).toBe(403);
    expect((await early.json()).error).toContain("아직 시작 전");
    expect((await request.get("/tests/00000000-0000-4000-8000-000000000000", { maxRedirects: 0 })).status()).toBe(307);

    // 로그아웃 후 같은 계정으로 로그인 탭에서 재로그인
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?error=1$/);
    await expect(page.locator('.error-box[role="alert"]')).toHaveText("이메일 또는 비밀번호가 맞지 않아요.");
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호", { exact: true }).fill("e2e-password");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3101/");
    await expect(page.getByText("김담당", { exact: true })).toBeVisible();
  });
});
