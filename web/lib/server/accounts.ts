import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Account } from "../types.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { storeDir } from "./store.ts";

const SCRYPT_N = 16384;
const KEY_LENGTH = 32;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[0-9a-f-]{36}$/;
export const PASSWORD_MIN = 8;
export const NAME_MAX = 40;
export const COMPANY_MAX = 80;

const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || Number(n) !== SCRYPT_N || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const emailKey = (email: string) => createHash("sha256").update(normalizeEmail(email)).digest("hex");
const accountPath = (id: string) => {
  if (!ID_RE.test(id)) throw new Error("잘못된 계정 ID");
  return path.join(storeDir(), "accounts", `${id}.json`);
};
const emailPath = (email: string) => path.join(storeDir(), "account-emails", `${emailKey(email)}.json`);

export type SignupInput = { email?: unknown; password?: unknown; passwordConfirm?: unknown; name?: unknown; company?: unknown };
export type SignupErrorCode = "email" | "password" | "mismatch" | "name" | "company" | "exists";

export function validateSignup(input: SignupInput): { ok: true; email: string; password: string; name: string; company: string } | { ok: false; code: SignupErrorCode } {
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
  const password = typeof input.password === "string" ? input.password : "";
  const confirm = typeof input.passwordConfirm === "string" ? input.passwordConfirm : password;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const company = typeof input.company === "string" ? input.company.trim() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, code: "email" };
  if (password.length < PASSWORD_MIN || password.length > 200) return { ok: false, code: "password" };
  if (password !== confirm) return { ok: false, code: "mismatch" };
  if (!name || name.length > NAME_MAX) return { ok: false, code: "name" };
  if (company.length > COMPANY_MAX) return { ok: false, code: "company" };
  return { ok: true, email, password, name, company };
}

export const SIGNUP_ERRORS: Record<SignupErrorCode, string> = {
  email: "올바른 이메일을 입력해주세요.",
  password: `비밀번호는 ${PASSWORD_MIN}자 이상이어야 해요.`,
  mismatch: "비밀번호 확인이 일치하지 않아요.",
  name: `이름은 1~${NAME_MAX}자로 입력해주세요.`,
  company: `회사명은 ${COMPANY_MAX}자 이하로 입력해주세요.`,
  exists: "이미 가입된 이메일이에요. 로그인해주세요.",
};

export class SignupError extends Error {
  code: SignupErrorCode;
  constructor(code: SignupErrorCode) {
    super(SIGNUP_ERRORS[code]);
    this.code = code;
  }
}

/** 이메일 색인 파일을 wx로 만들어 중복 가입을 원자적으로 막는다. */
export async function createAccount(input: SignupInput, now = new Date()): Promise<Account> {
  const checked = validateSignup(input);
  if (!checked.ok) throw new SignupError(checked.code);
  const id = randomUUID();
  await mkdir(path.join(storeDir(), "account-emails"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(emailPath(checked.email), JSON.stringify({ accountId: id }), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SignupError("exists");
    throw e;
  }
  const account: Account = { id, email: checked.email, name: checked.name, company: checked.company, passwordHash: await hashPassword(checked.password), createdAt: now.toISOString() };
  await writeJsonAtomic(accountPath(id), account);
  return account;
}

export async function getAccount(id: string): Promise<Account | null> {
  if (!ID_RE.test(id)) return null;
  return readJson<Account>(accountPath(id));
}

export async function findAccountByEmail(email: string): Promise<Account | null> {
  if (!EMAIL_RE.test(normalizeEmail(email))) return null;
  const ref = await readJson<{ accountId: string }>(emailPath(email));
  return ref ? getAccount(ref.accountId) : null;
}

export async function authenticate(email: string, password: string): Promise<Account | null> {
  const account = await findAccountByEmail(email);
  if (!account) return null;
  return (await verifyPassword(password, account.passwordHash)) ? account : null;
}

export const publicAccount = (a: Account) => ({ id: a.id, email: a.email, name: a.name, company: a.company });
