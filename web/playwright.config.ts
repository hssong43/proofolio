import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/paid.spec.ts",
  outputDir: join(tmpdir(), "proofolio-playwright-results"),
  reporter: "list",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:3101",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "npm run build && npm run start -- --port 3101",
    url: "http://127.0.0.1:3101",
    // Never reuse a server that may have real credentials or a paid budget.
    reuseExistingServer: false,
    env: { PROOFOLIO_E2E:'1', OPENROUTER_API_KEY: "", PROOFOLIO_MAX_COST_USD: "0", PROOFOLIO_STORAGE: "local", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_PUBLISHABLE_KEY:'', PROOFOLIO_APP_URL:'http://127.0.0.1:3101' },
    timeout: 120_000,
  },
});
