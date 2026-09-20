import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Candidate, CompletionPayload, Submission, TestRecord, TestSummary } from "../types.ts";
import { generateCode, isValidCode, normalizeCode } from "../codes.ts";
import { testStatus } from "../period.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

const UUID_RE = /^[0-9a-f-]{36}$/;
const DEFAULT_TOTAL_SECONDS = 40;
const DEFAULT_QUESTION_COUNT = 5;

/** 저장 위치. 테스트는 PROOFOLIO_STORE_DIR로 임시 폴더를 지정한다. */
export function storeDir(env = process.env): string {
  if (env.PROOFOLIO_STORE_DIR) return path.resolve(env.PROOFOLIO_STORE_DIR);
  const root = env.PROOFOLIO_ROOT ?? (existsSync(path.join(process.cwd(), "src", "cli.ts")) ? process.cwd() : path.join(process.cwd(), ".."));
  return path.resolve(root, "output", "web", "store");
}

const assertId = (id: string, label: string) => {
  if (!UUID_RE.test(id)) throw new Error(`잘못된 ${label} ID`);
  return id;
};
const testPath = (id: string) => path.join(storeDir(), "tests", `${assertId(id, "테스트")}.json`);
const codePath = (code: string) => {
  if (!isValidCode(code)) throw new Error("잘못된 코드");
  return path.join(storeDir(), "codes", `${code}.json`);
};
const submissionDir = (testId: string) => path.join(storeDir(), "submissions", assertId(testId, "테스트"));
const submissionPath = (testId: string, id: string) => path.join(submissionDir(testId), `${assertId(id, "제출")}.json`);

async function listJsonIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export type CreateTestInput = { title: string; startsAt: string; endsAt: string; totalSeconds?: number; questionCount?: number; mode?: TestRecord["mode"] };

/** 코드 파일을 wx로 만들어 유일성을 원자적으로 보장한다. 충돌 시 새 코드로 재시도. */
export async function createTest(input: CreateTestInput, options: { nextCode?: () => string; now?: () => Date } = {}): Promise<TestRecord> {
  const nextCode = options.nextCode ?? generateCode;
  const id = randomUUID();
  await mkdir(path.join(storeDir(), "codes"), { recursive: true, mode: 0o700 });
  let code = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = nextCode();
    try {
      await writeFile(codePath(candidate), JSON.stringify({ testId: id }), { flag: "wx", mode: 0o600 });
      code = candidate;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  if (!code) throw new Error("코드를 발급하지 못했어요. 다시 시도해주세요.");
  const test: TestRecord = {
    id, code, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    totalSeconds: input.totalSeconds ?? DEFAULT_TOTAL_SECONDS, questionCount: input.questionCount ?? DEFAULT_QUESTION_COUNT,
    mode: input.mode ?? "demo",
  };
  await writeJsonAtomic(testPath(id), test);
  return test;
}

export async function getTest(testId: string): Promise<TestRecord | null> {
  return readJson<TestRecord>(testPath(testId));
}

export async function findTestByCode(rawCode: string): Promise<TestRecord | null> {
  const code = normalizeCode(rawCode);
  if (!isValidCode(code)) return null;
  const ref = await readJson<{ testId: string }>(codePath(code));
  if (!ref || !UUID_RE.test(ref.testId)) return null;
  return getTest(ref.testId);
}

export async function listSubmissions(testId: string): Promise<Submission[]> {
  const ids = await listJsonIds(submissionDir(testId));
  const rows = await Promise.all(ids.map((id) => readJson<Submission>(submissionPath(testId, id))));
  return rows.filter((s): s is Submission => !!s).sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
}

export async function listTests(now = Date.now()): Promise<TestSummary[]> {
  const ids = await listJsonIds(path.join(storeDir(), "tests"));
  const tests = (await Promise.all(ids.map((id) => getTest(id)))).filter((t): t is TestRecord => !!t);
  const summaries = await Promise.all(tests.map(async (t) => {
    const submissions = await listSubmissions(t.id);
    return { ...t, status: testStatus(t, now), submissionCount: submissions.length, completedCount: submissions.filter((s) => s.state === "completed").length };
  }));
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createSubmission(testId: string, candidate: Candidate, now = new Date()): Promise<Submission> {
  if (!(await getTest(testId))) throw new Error("테스트를 찾을 수 없어요.");
  const submission: Submission = { id: randomUUID(), testId, candidate, state: "joined", joinedAt: now.toISOString() };
  await writeJsonAtomic(submissionPath(testId, submission.id), submission);
  return submission;
}

export async function getSubmission(testId: string, submissionId: string): Promise<Submission | null> {
  return readJson<Submission>(submissionPath(testId, submissionId));
}

/** 같은 내용으로 다시 호출해도 결과가 같다(StrictMode 이중 호출 대비). */
export async function completeSubmission(testId: string, submissionId: string, payload: CompletionPayload, now = new Date()): Promise<Submission> {
  const current = await getSubmission(testId, submissionId);
  if (!current) throw new Error("제출을 찾을 수 없어요.");
  const next: Submission = {
    ...current, state: "completed", completedAt: current.completedAt ?? now.toISOString(),
    role: payload.role, roleLabel: payload.roleLabel, questions: payload.questions, answers: payload.answers,
    elapsedSeconds: payload.elapsedSeconds, runId: payload.runId,
  };
  await writeJsonAtomic(submissionPath(testId, submissionId), next);
  return next;
}
