import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "proofolio_admin";
export const CANDIDATE_COOKIE = "proofolio_candidate";
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
export const CANDIDATE_TTL_MS = 4 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

export function adminPassword(env: Env = process.env): string {
  const password = env.PROOFOLIO_ADMIN_PASSWORD ?? "";
  if (!password) throw new Error("PROOFOLIO_ADMIN_PASSWORD가 설정되지 않았어요.");
  return password;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function checkPassword(input: string, env: Env = process.env): boolean {
  return timingSafeEqual(sha256(input), sha256(adminPassword(env)));
}

const key = (env: Env) => sha256("proofolio-session:" + (env.PROOFOLIO_SESSION_SECRET || adminPassword(env)));
const sign = (payload: string, env: Env) => createHmac("sha256", key(env)).update(payload).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function issueAdminToken(now = Date.now(), env: Env = process.env): string {
  const exp = String(now + ADMIN_TTL_MS);
  return `admin.${exp}.${sign(`admin.${exp}`, env)}`;
}

export function verifyAdminToken(token: string | undefined, now = Date.now(), env: Env = process.env): boolean {
  if (!token) return false;
  const [kind, exp, sig] = token.split(".");
  if (kind !== "admin" || !/^\d+$/.test(exp ?? "") || !sig) return false;
  try {
    return safeEqual(sig, sign(`admin.${exp}`, env)) && Number(exp) > now;
  } catch {
    return false;
  }
}

/** 응시자 토큰에는 testId를 넣어 답변 저장 시 폴더를 바로 찾는다. */
export function issueCandidateToken(testId: string, submissionId: string, env: Env = process.env): string {
  return `${testId}.${submissionId}.${sign(`cand.${testId}.${submissionId}`, env)}`;
}

export function verifyCandidateToken(token: string | undefined, submissionId: string, env: Env = process.env): { testId: string } | null {
  if (!token) return null;
  const [testId, id, sig] = token.split(".");
  if (!testId || !id || !sig || id !== submissionId) return null;
  try {
    return safeEqual(sig, sign(`cand.${testId}.${id}`, env)) ? { testId } : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAdminRequest(request: Request, now = Date.now(), env: Env = process.env): boolean {
  return verifyAdminToken(parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE], now, env);
}

export function candidateOf(request: Request, submissionId: string, env: Env = process.env): { testId: string } | null {
  return verifyCandidateToken(parseCookies(request.headers.get("cookie"))[CANDIDATE_COOKIE], submissionId, env);
}

export function cookieHeader(name: string, value: string, request: Request, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
