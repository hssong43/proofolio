import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rename, link, unlink } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type { AnswerRecord, ClientQuestion, ClientResult, RunStatus, Track } from "../types.ts";
import { loadRuntimeEnv, executionBudget } from "../../../src/env.ts";
import { DEFAULT_MAX_QUESTIONS, MIN_TARGET_QUESTIONS, ANSWER_MAX_LENGTH } from "../../../src/constants.ts";
import { storageMode, syncRun, syncAnswers, databaseRun, databaseAnswers, rpc, runPayload, type StoredRun } from "./database.ts";
export { DEFAULT_MAX_QUESTIONS } from "../../../src/constants.ts";

/** 분석 코어(루트 저장소) 위치. 기본은 web/의 상위 폴더. */
export const ROOT = path.resolve(process.env.PROOFOLIO_ROOT ?? (existsSync(path.join(process.cwd(), "src", "cli.ts")) ? process.cwd() : path.join(process.cwd(), "..")));
const RUNS_DIR = path.join(ROOT, "output", "web", "runs");
const RUN_ID = /^[0-9a-f-]{36}$/;

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const parsed = new URL(origin);
    // Next's internal request URL can use localhost while the browser uses 127.0.0.1.
    return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin &&
      parsed.host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch { return false; }
}

const runDir = (runId: string) => {
  if (!RUN_ID.test(runId)) throw new Error("잘못된 실행 ID");
  return path.join(RUNS_DIR, runId);
};

async function writeStatus(status: StoredRun) {
  const target = path.join(runDir(status.runId), "status.json"), temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(status, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

export async function readStatus(runId: string): Promise<StoredRun | null> {
  if (!RUN_ID.test(runId)) return null;
  if (storageMode() === 'supabase') {
    const remote = await databaseRun(runId);
    if (!remote || remote.state === 'complete' || remote.state === 'failed') return remote;
    try {
      const local = JSON.parse(await readFile(path.join(runDir(runId), 'status.json'), 'utf8')) as StoredRun;
      if (local.userId === remote.userId && (local.state === 'complete' || local.state === 'failed')) {
        try { await syncRun(local); } catch { local.storageError='DB 저장이 지연됐어요. 분석을 다시 실행하지 않고 저장만 재시도해요.'; }
        return local;
      }
      if (local.userId === remote.userId && Date.now()-Date.parse(remote.startedAt)<2*60*60*1000) return local;
    } catch { /* Remote ownership/state remains canonical when local disk is absent. */ }
    if (Date.now() - Date.parse(remote.startedAt) > 2 * 60 * 60 * 1000) {
      remote.state = 'failed'; remote.error = '실행 서버가 중단되었거나 제한 시간을 초과했어요. 자동으로 유료 분석을 다시 실행하지 않아요.';
      remote.finishedAt = new Date().toISOString(); await syncRun(remote);
    }
    return remote;
  }
  try {
    return JSON.parse(await readFile(path.join(runDir(runId), "status.json"), "utf8")) as StoredRun;
  } catch {
    return null;
  }
}

export async function saveAnswer(runId: string, userId: string, answer: AnswerRecord) {
  const status = await ownedStatus(runId, userId);
  if (status.state !== 'complete' || !status.result?.questions.some(q => q.id === answer?.questionId)) throw new AnswerError('완료된 질문을 확인해주세요.', 409);
  if (!answer || Object.keys(answer).sort().join() !== 'answer,questionId,seconds' || typeof answer.answer !== 'string' ||
    answer.answer.length > ANSWER_MAX_LENGTH || !Number.isSafeInteger(answer.seconds) || answer.seconds < 0) throw new AnswerError('답변 형식을 확인해주세요.', 400);
  if (status.storage !== 'supabase') throw new AnswerError('문항별 저장에는 DB 연결이 필요해요.', 503);
  await syncRun(status);
  const saved = await rpc('proofolio_save_answer', { p_run_id: runId, p_user_id: userId, p_answer: answer });
  if (saved !== answer.questionId) throw new Error('답변 저장 확인에 실패했어요.');
  return databaseAnswers(runId);
}

export class AnswerError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function ownedStatus(runId: string, userId?: string): Promise<StoredRun> {
  const status = await readStatus(runId);
  // Old ownerless runs stay operator-only on disk. A run ID is not an access credential.
  if (!userId || !status?.userId || status.userId !== userId) throw new AnswerError("실행을 찾을 수 없어요.", 404);
  return status;
}

export async function saveAnswers(runId: string, input: unknown) {
  const status = await readStatus(runId);
  if (!status) throw new AnswerError("실행을 찾을 수 없습니다.", 404);
  const ids = status.result?.questions.map(q => q.id) ?? [];
  if (status.state !== "complete" || !ids.length) throw new AnswerError("질문이 있는 완료된 실행에만 답변할 수 있어요.", 409);
  if (!Array.isArray(input) || input.length !== ids.length || new Set(input.map(a => a?.questionId)).size !== ids.length ||
    input.some(a => !a || typeof a !== "object" || Object.keys(a).sort().join() !== "answer,questionId,seconds" ||
      !ids.includes(a.questionId) || typeof a.answer !== "string" || a.answer.length > ANSWER_MAX_LENGTH ||
      !Number.isSafeInteger(a.seconds) || a.seconds < 0)) throw new AnswerError("질문 ID·중복·답변 값 형식을 확인해주세요.", 400);
  const answers: AnswerRecord[] = ids.map(id => input.find(a => a.questionId === id));
  await mkdir(runDir(runId), { recursive: true, mode: 0o700 });
  const target = path.join(runDir(runId), "answers.json"), temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify({ runId, savedAt: new Date().toISOString(), answers }, null, 2), { flag: "wx", mode: 0o600 });
  try {
    // Publish a complete file exclusively. Concurrent identical retries cannot overwrite the first save.
    try { await link(temporary, target); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = JSON.parse(await readFile(target, "utf8"));
      if (JSON.stringify(existing.answers) !== JSON.stringify(answers)) throw new AnswerError("이미 저장된 답변과 달라 덮어쓰지 않았어요.", 409);
    }
  } finally { await unlink(temporary); }
  loadRuntimeEnv(ROOT);
  await syncAnswers(status, answers);
  return answers.length;
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
  if (/OPENROUTER_API_KEY/.test(text)) return "OPENROUTER_API_KEY가 설정되지 않았어요. 루트 .env를 확인해주세요.";
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
  anchors: Array<{ page: number; quote?: string | null; box?: [number, number, number, number] }>;
};

type RawResult = {
  schema_version?: string;
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
    // Source quotes may contain line breaks. Use the core's immutable anchor quotes,
    // not a last-line split that can silently truncate the candidate's question.
    const sourceQuotes = [...new Set(q.anchors.flatMap((a) => a.quote ? [a.quote] : []))];
    let prompt = q.question;
    const notes: string[] = [];
    const visualNote = "연결된 시각 자료를 기준으로 답해 주세요.";
    if (prompt.startsWith(visualNote + "\n")) { notes.push(visualNote); prompt = prompt.slice(visualNote.length + 1); }
    for (const quote of sourceQuotes) if (prompt.startsWith("원문: " + quote + "\n")) prompt = prompt.slice(quote.length + 5);
    return {
      id: q.id,
      prompt,
      quotes: sourceQuotes,
      notes,
      pages: [...new Set(q.anchors.map((a) => a.page))].sort((a, b) => a - b),
      projectTitle: titles.get(q.project_key) ?? q.project_key,
      intent: q.intent,
      listenFor: q.listen_for,
      answerTarget: q.answer_target,
      anchors: q.anchors.filter(a => a.box).map(a => ({ page: a.page, box: a.box, assetId: `crop-${a.page}-${a.box!.join('-')}` })),
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

export function analysisArgs(runId: string, track: Track, maxQuestions = DEFAULT_MAX_QUESTIONS, env = process.env) {
  if (!['design','marketing','coding'].includes(track)) throw new Error("지원하지 않는 직무예요.");
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > DEFAULT_MAX_QUESTIONS) throw new Error(`질문 수는 1~${DEFAULT_MAX_QUESTIONS}개예요.`);
  const dir = runDir(runId), budget = executionBudget(ROOT, env);
  if (track==='coding') return [path.join(ROOT,'src','coding-cli.ts'),path.join(dir,'code.json'),
    '--output',path.join(dir,'result.json'),'--budget-ledger',budget.ledger,'--max-cost-usd',String(budget.limit),'--max-questions',String(maxQuestions)];
  return [path.join(ROOT, "src", "cli.ts"), path.join(dir, "portfolio.pdf"),
    "--provider", "openrouter", "--track", track,
    "--output", path.join(dir, "result.json"), "--guide-output", path.join(dir, "questions.txt"),
    "--raw-response-dir", path.join(dir, "raw"), "--preview-dir", path.join(dir, "regions"),
    "--budget-ledger", budget.ledger, "--max-cost-usd", String(budget.limit),
    "--max-questions", String(maxQuestions), "--events"];
}

export async function startRun(input: { bytes: Uint8Array; fileName: string; track: Track; maxQuestions?: number; userId?: string; member?: boolean }) {
  loadRuntimeEnv(ROOT);
  const runId = randomUUID();
  const args = analysisArgs(runId, input.track, input.maxQuestions);
  const dir = runDir(runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pdfPath = path.join(dir, input.track==='coding' ? 'code.json' : "portfolio.pdf");
  await writeFile(pdfPath, input.bytes, { flag: "wx", mode: 0o600 });

  const status: StoredRun = { runId, track: input.track, fileName: input.fileName, state: "queued", stage: 0, startedAt: new Date().toISOString(),
    userId: input.userId, pdfSha256: createHash("sha256").update(input.bytes).digest("hex"),
    requestedQuestions: input.maxQuestions ?? DEFAULT_MAX_QUESTIONS, storage: storageMode() };
  await writeStatus(status);

  status.state = "running";
  // Fail before starting a paid child when database configuration/migration is missing.
  let admitted=false;
  try {
    if (input.member && status.storage === 'supabase') {
      if ((input.maxQuestions ?? DEFAULT_MAX_QUESTIONS) < MIN_TARGET_QUESTIONS) throw new Error('질문 요청은 6~10개예요.');
      await rpc('proofolio_start_member_run', { p_run: runPayload(status) });
      admitted=true;
      const { uploadAsset, assetPrefix } = await import('./assets.ts');
      await uploadAsset(assetPrefix(status.userId!, runId) + (input.track==='coding'?'code.json':'portfolio.pdf'), input.bytes, input.track==='coding'?'application/json':'application/pdf');
    } else await syncRun(status);
  }
  catch (e) {
    status.state = "failed"; status.error = "저장소 준비에 실패해 분석을 시작하지 않았어요.";
    status.finishedAt = new Date().toISOString();
    if(admitted) { try {await syncRun(status);} catch { /* Local state can be reconciled by readStatus. */ } }
    await writeStatus(status); throw e;
  }
  await writeStatus(status);
  // ponytail: one local process per run; use a durable worker before multi-instance deployment.
  let writes = Promise.resolve();
  const persist = () => { const snapshot = structuredClone(status); writes = writes.then(() => writeStatus(snapshot)); return writes; };
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const events = createWriteStream(path.join(dir, "events.jsonl"), { flags: "wx", mode: 0o600 });
  let stderr = "";
  child.on("error", () => { stderr += "\n분석 프로세스를 시작하지 못했어요."; });
  events.on("error", () => { child.kill("SIGTERM"); });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    events.write(line + "\n");
    try {
      const event = JSON.parse(line) as { type: string; data?: unknown };
      status.stage = stageOf(event, status.stage);
      status.lastEvent = event.type;
      void persist().catch(() => { child.kill("SIGTERM"); });
    } catch {
      /* 이벤트가 아닌 출력은 무시 */
    }
  });
  const finish = async (code: number | null) => {
    events.end();
    await writeFile(path.join(dir, "stderr.log"), stderr, { flag: "wx", mode: 0o600 });
    status.finishedAt = new Date().toISOString();
    if (code === 0) {
      try {
        const raw = JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")) as RawResult & {client_result?:ClientResult};
        status.result = input.track==='coding' ? raw.client_result : toClientResult(raw);
        if(!status.result)throw new Error('결과가 없어요.');
        if (status.storage === 'supabase') {
          const { storeSources, storeCodeSources, assetPrefix } = await import('./assets.ts');
          try {
            status.result.sourceAssets = input.track==='coding'
              ? await storeCodeSources(status.userId!,runId,JSON.parse(Buffer.from(input.bytes).toString('utf8')).files,raw)
              : await storeSources(status.userId!, runId, input.bytes, status.result, raw);
          } catch {
            status.result.qualityIssues.push('source_storage_incomplete');
            status.result.status='needs_review';
            if(input.track!=='coding') status.result.sourceAssets=[{id:'pdf',page:0,kind:'pdf',path:assetPrefix(status.userId!,runId)+'portfolio.pdf'}];
          }
        }
        status.metrics = raw.metrics;
        status.schemaVersion = raw.schema_version;
        status.state = "complete";
        status.stage = 3;
      } catch (e) {
        status.state = "failed";
        delete status.result;
        status.error = '결과 파일을 읽지 못했어요. 저장된 실행 기록을 확인해주세요.';
      }
    } else {
      status.state = "failed";
      status.error = friendlyError(stderr.split("\n").filter(Boolean).at(-1) ?? "");
    }
    try { await syncRun(status); }
    catch { status.storageError = "분석 기록의 DB 저장이 지연됐어요. 답변 저장 때 분석 없이 다시 시도해요."; }
    await persist();
  };
  child.on("close", (code) => { void finish(code).catch(() => console.error("분석 상태를 저장하지 못했습니다. 로컬 디스크를 확인하세요.")); });
  return status;
}
