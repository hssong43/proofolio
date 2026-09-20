import type { Candidate } from "./types.ts";

export const NAME_MAX = 40;

export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function isValidBirthDate(value: string, now = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
  return y >= 1900 && date.getTime() <= now.getTime();
}

export function validateCandidate(input: unknown, now = new Date()): { ok: true; candidate: Candidate } | { ok: false; error: string } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const birthDate = typeof raw.birthDate === "string" ? raw.birthDate.trim() : "";
  const phone = typeof raw.phone === "string" ? normalizePhone(raw.phone) : "";
  if (!name || name.length > NAME_MAX) return { ok: false, error: `이름은 1~${NAME_MAX}자로 입력해주세요.` };
  if (!isValidBirthDate(birthDate, now)) return { ok: false, error: "생년월일은 YYYY-MM-DD 형식으로 입력해주세요." };
  if (phone.length < 10 || phone.length > 11) return { ok: false, error: "전화번호는 숫자 10~11자리로 입력해주세요." };
  return { ok: true, candidate: { name, birthDate, phone } };
}

export function formatPhone(digits: string): string {
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}
