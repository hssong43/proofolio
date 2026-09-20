import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import type { Candidate, CompletionPayload, RoleId, Submission, TestRecord, TestSummary } from "../types.ts";
import { CODE_ALPHABET, CODE_LENGTH, isValidCode, normalizeCode } from "../codes.ts";
import { testStatus } from "../period.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { evaluateSubmission } from "./evaluate.ts";

const UUID_RE = /^[0-9a-f-]{36}$/;

/** 서버 전용: 브라우저 번들에 node:crypto가 들어가지 않도록 codes.ts와 분리한다. */
export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
const DEFAULT_TOTAL_SECONDS = 40;
const DEFAULT_QUESTION_COUNT = 10;
export const DEFAULT_PASS_SCORE = 70;

/** 저장 위치. 테스트는 PROOFOLIO_STORE_DIR로 임시 폴더를 지정한다. */
export function storeDir(env: Record<string, string | undefined> = process.env): string {
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

export type CreateTestInput = { title: string; role: RoleId; startsAt: string; endsAt: string; passScore?: number; createdBy?: string; totalSeconds?: number; questionCount?: number; mode?: TestRecord["mode"] };

/** 예전 파일에 없던 필드를 기본값으로 채운다. */
function normalizeTest(raw: TestRecord | null): TestRecord | null {
  if (!raw) return null;
  return { ...raw, role: raw.role ?? "designer", passScore: Number.isInteger(raw.passScore) ? raw.passScore : DEFAULT_PASS_SCORE };
}

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
    id, code, title: input.title, role: input.role, startsAt: input.startsAt, endsAt: input.endsAt,
    createdAt: (options.now?.() ?? new Date()).toISOString(), ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    totalSeconds: input.totalSeconds ?? DEFAULT_TOTAL_SECONDS, questionCount: input.questionCount ?? DEFAULT_QUESTION_COUNT,
    passScore: input.passScore ?? DEFAULT_PASS_SCORE, mode: input.mode ?? "demo",
  };
  await writeJsonAtomic(testPath(id), test);
  return test;
}

export async function getTest(testId: string): Promise<TestRecord | null> {
  return normalizeTest(await readJson<TestRecord>(testPath(testId)));
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
    const completed = submissions.filter((s) => s.state === "completed");
    return { ...t, status: testStatus(t, now), submissionCount: submissions.length, completedCount: completed.length, passedCount: completed.filter((s) => s.evaluation?.passed).length };
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

/** 같은 내용으로 다시 호출해도 결과가 같다(StrictMode 이중 호출 대비). 완료 시 mock 평가를 함께 저장한다. */
export async function completeSubmission(testId: string, submissionId: string, payload: CompletionPayload, now = new Date()): Promise<Submission> {
  const [current, test] = await Promise.all([getSubmission(testId, submissionId), getTest(testId)]);
  if (!current || !test) throw new Error("제출을 찾을 수 없어요.");
  const completedAt = current.completedAt ?? now.toISOString();
  const evaluation = current.evaluation ?? evaluateSubmission({ questions: payload.questions, answers: payload.answers, passScore: test.passScore }, new Date(completedAt));
  const next: Submission = {
    ...current, state: "completed", completedAt,
    role: payload.role, roleLabel: payload.roleLabel, questions: payload.questions, answers: payload.answers,
    elapsedSeconds: payload.elapsedSeconds, runId: payload.runId, evaluation,
  };
  await writeJsonAtomic(submissionPath(testId, submissionId), next);
  return next;
}
