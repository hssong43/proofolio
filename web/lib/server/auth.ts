import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "proofolio_admin";
export const CANDIDATE_COOKIE = "proofolio_candidate";
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
export const CANDIDATE_TTL_MS = 4 * 60 * 60 * 1000;

const key = (secret: string) => {
  if (!secret) throw new Error("세션 비밀이 비어 있어요.");
  return createHash("sha256").update("proofolio-session:" + secret).digest();
};
const sign = (payload: string, secret: string) => createHmac("sha256", key(secret)).update(payload).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ID_RE = /^[0-9a-f-]{36}$/;

export function issueAdminToken(accountId: string, secret: string, now = Date.now()): string {
  const exp = String(now + ADMIN_TTL_MS);
  return `admin.${accountId}.${exp}.${sign(`admin.${accountId}.${exp}`, secret)}`;
}

export function verifyAdminToken(token: string | undefined, secret: string, now = Date.now()): { accountId: string } | null {
  if (!token) return null;
  const [kind, accountId, exp, sig] = token.split(".");
  if (kind !== "admin" || !ID_RE.test(accountId ?? "") || !/^\d+$/.test(exp ?? "") || !sig) return null;
  try {
    return safeEqual(sig, sign(`admin.${accountId}.${exp}`, secret)) && Number(exp) > now ? { accountId } : null;
  } catch {
    return null;
  }
}

/** 응시자 토큰에는 testId를 넣어 답변 저장 시 폴더를 바로 찾는다. */
export function issueCandidateToken(testId: string, submissionId: string, secret: string): string {
  return `${testId}.${submissionId}.${sign(`cand.${testId}.${submissionId}`, secret)}`;
}

export function verifyCandidateToken(token: string | undefined, submissionId: string, secret: string): { testId: string } | null {
  if (!token) return null;
  const [testId, id, sig] = token.split(".");
  if (!testId || !id || !sig || id !== submissionId) return null;
  try {
    return safeEqual(sig, sign(`cand.${testId}.${id}`, secret)) ? { testId } : null;
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

export function adminOf(request: Request, secret: string, now = Date.now()): { accountId: string } | null {
  return verifyAdminToken(parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE], secret, now);
}

export function candidateOf(request: Request, submissionId: string, secret: string): { testId: string } | null {
  return verifyCandidateToken(parseCookies(request.headers.get("cookie"))[CANDIDATE_COOKIE], submissionId, secret);
}

export function cookieHeader(name: string, value: string, request: Request, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
