import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeEnv } from "../src/env.ts";
import { OPENROUTER_MODELS } from "../src/openrouter.ts";

if (process.env.PROOFOLIO_PAID_E2E !== "1" || process.env.PROOFOLIO_MAX_COST_USD !== "10")
  throw new Error("Paid E2E requires PROOFOLIO_PAID_E2E=1 and the existing $10 ledger approval.");
if (!/^[a-z0-9-]+$/.test(process.env.PROOFOLIO_E2E_RUN ?? "")) throw new Error("Set a new PROOFOLIO_E2E_RUN name.");
loadRuntimeEnv(join(process.cwd(), ".."));
if (!process.env.PROOFOLIO_E2E_EMAIL || !process.env.PROOFOLIO_E2E_PASSWORD || process.env.PROOFOLIO_STORAGE !== 'supabase')
  throw new Error('Paid E2E requires a confirmed test member (PROOFOLIO_E2E_EMAIL/PASSWORD) and Supabase storage.');

export default defineConfig({
  testDir: "./e2e", testMatch: "paid.spec.ts", workers: 1, retries: 0, maxFailures: 1,
  outputDir: join(tmpdir(), "proofolio-paid-e2e", process.env.PROOFOLIO_E2E_RUN!), reporter: "list",
  timeout: 1_800_000, expect: { timeout: 15_000 },
  // Credentials must never be captured in a Playwright trace.
  use: { baseURL: "http://127.0.0.1:3102", browserName: "chromium", trace: "off" },
  webServer: {
    command: "npm run build && npm run start -- --port 3102", url: "http://127.0.0.1:3102",
    reuseExistingServer: false, timeout: 120_000,
    env: { PROOFOLIO_E2E: '1', PROOFOLIO_CONTEST_MODE:'0', PROOFOLIO_APP_URL: 'http://127.0.0.1:3102',
      PROOFOLIO_MAX_COST_USD: "10", PROOFOLIO_BUDGET_LEDGER: "output/openrouter-budget.jsonl",
      OPENROUTER_MODEL: OPENROUTER_MODELS.vision, OPENROUTER_SKIM_MODEL: OPENROUTER_MODELS.skim,
      OPENROUTER_REVIEW_MODEL: OPENROUTER_MODELS.vision, OPENROUTER_QUESTION_MODEL: OPENROUTER_MODELS.questions },
  },
});
