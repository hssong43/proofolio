import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AnswerRecord, ClientQuestion, ClientResult, RunStatus, Track } from "../types";

/** 분석 코어(루트 저장소) 위치. 기본은 web/의 상위 폴더. */
export const ROOT = path.resolve(process.env.PROOFOLIO_ROOT ?? path.join(process.cwd(), ".."));
const RUNS_DIR = path.join(ROOT, "output", "web", "runs");
const LEDGER = process.env.PROOFOLIO_BUDGET_LEDGER ?? path.join(ROOT, "output", "web", "api-budget.jsonl");
export const DEFAULT_MAX_QUESTIONS = 10;
const RUN_ID = /^[0-9a-f-]{36}$/;

const runDir = (runId: string) => {
  if (!RUN_ID.test(runId)) throw new Error("잘못된 실행 ID");
  return path.join(RUNS_DIR, runId);
};

async function writeStatus(status: RunStatus) {
  await writeFile(path.join(runDir(status.runId), "status.json"), JSON.stringify(status, null, 2));
}

export async function readStatus(runId: string): Promise<RunStatus | null> {
  try {
    return JSON.parse(await readFile(path.join(runDir(runId), "status.json"), "utf8")) as RunStatus;
  } catch {
    return null;
  }
}

export async function saveAnswers(runId: string, answers: AnswerRecord[]) {
  const status = await readStatus(runId);
  if (!status) throw new Error("실행을 찾을 수 없습니다.");
  await writeFile(path.join(runDir(runId), "answers.json"), JSON.stringify({ runId, savedAt: new Date().toISOString(), answers }, null, 2));
}

/** 코어의 stage/complete 이벤트를 화면 진행 단계로 바꾼다. */
function stageOf(event: { type: string; data?: unknown }, current: number) {
  if (event.type === "complete") return 3;
  if (event.type !== "stage") return current;
  const stage = (event.data as { stage?: string } | undefined)?.stage;
  if (stage === "skim") return Math.max(current, 0);
  if (stage === "visual_inventory" || stage === "extract" || stage === "review") return Math.max(current, 1);
  if (stage === "questions") return Math.max(current, 2);
  return current;
}

function friendlyError(raw: string) {
  const text = raw.trim();
  if (/GEMINI_API_KEY/.test(text)) return "GEMINI_API_KEY가 설정되지 않았어요. 루트 .env에 키를 넣은 뒤 다시 시도해주세요.";
  if (/EEXIST/.test(text) && /\.lock/.test(text)) return "다른 분석이 진행 중이에요. 잠시 후 다시 시도해주세요.";
  return text.replace(/^분석 실패:\s*/, "") || "분석이 완료되지 않았어요.";
}

type RawQuestion = {
  id: string;
  question: string;
  intent: string;
  listen_for: string[];
  answer_target: string;
  project_key: string;
  anchors: Array<{ page: number }>;
};

type RawResult = {
  status: string;
  quality: { issues: string[] };
  document: { page_count: number };
  document_map: { projects: Array<{ key: string; title: string; pages: number[] }> };
  analysis_plan: { selected_project_keys: string[] };
  evidence: unknown[];
  questions: RawQuestion[];
  metrics: { estimated_cost_usd: number };
  max_questions?: number;
};

export function toClientResult(raw: RawResult): ClientResult {
  const titles = new Map(raw.document_map.projects.map((p) => [p.key, p.title]));
  const questions: ClientQuestion[] = raw.questions.map((q) => {
    const lines = q.question.split("\n").filter((l) => l.trim());
    const prompt = lines.at(-1) ?? q.question;
    const head = lines.slice(0, -1);
    return {
      id: q.id,
      prompt,
      quotes: head.filter((l) => l.startsWith("원문: ")).map((l) => l.slice(4)),
      notes: head.filter((l) => !l.startsWith("원문: ")),
      pages: [...new Set(q.anchors.map((a) => a.page))].sort((a, b) => a - b),
      projectTitle: titles.get(q.project_key) ?? q.project_key,
      intent: q.intent,
      listenFor: q.listen_for,
      answerTarget: q.answer_target,
    };
  });
  return {
    status: raw.status,
    qualityIssues: raw.quality?.issues ?? [],
    pageCount: raw.document.page_count,
    projects: raw.document_map.projects.filter((p) => raw.analysis_plan.selected_project_keys.includes(p.key)),
    evidenceCount: raw.evidence.length,
    questions,
    estimatedCostUsd: raw.metrics.estimated_cost_usd,
    maxQuestions: raw.max_questions ?? questions.length,
  };
}

export async function startRun(input: { bytes: Uint8Array; fileName: string; track: Track; maxQuestions?: number }) {
  const runId = randomUUID();
  const dir = runDir(runId);
  await mkdir(dir, { recursive: true });
  await mkdir(path.dirname(LEDGER), { recursive: true });
  const pdfPath = path.join(dir, "portfolio.pdf");
  await writeFile(pdfPath, input.bytes);

  const status: RunStatus = { runId, track: input.track, fileName: input.fileName, state: "queued", stage: 0, startedAt: new Date().toISOString() };
  await writeStatus(status);

  const args = [
    path.join(ROOT, "src", "cli.ts"),
    pdfPath,
    "--track", input.track,
    "--output", path.join(dir, "result.json"),
    "--guide-output", path.join(dir, "questions.txt"),
    "--budget-ledger", LEDGER,
    "--max-questions", String(input.maxQuestions ?? DEFAULT_MAX_QUESTIONS),
    "--events",
  ];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  status.state = "running";
  await writeStatus(status);

  const events = createWriteStream(path.join(dir, "events.jsonl"));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    events.write(line + "\n");
    try {
      const event = JSON.parse(line) as { type: string; data?: unknown };
      status.stage = stageOf(event, status.stage);
      status.lastEvent = event.type;
      void writeStatus(status);
    } catch {
      /* 이벤트가 아닌 출력은 무시 */
    }
  });
  child.on("close", async (code) => {
    events.end();
    await writeFile(path.join(dir, "stderr.log"), stderr);
    status.finishedAt = new Date().toISOString();
    if (code === 0) {
      try {
        status.result = toClientResult(JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")) as RawResult);
        status.state = "complete";
        status.stage = 3;
      } catch (e) {
        status.state = "failed";
        status.error = `결과 파일을 읽지 못했어요: ${(e as Error).message}`;
      }
    } else {
      status.state = "failed";
      status.error = friendlyError(stderr.split("\n").filter(Boolean).at(-1) ?? "");
    }
    await writeStatus(status);
  });
  return status;
}
