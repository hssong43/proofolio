import { randomInt } from "node:crypto";

/** 헷갈리는 I, O, 0, 1을 뺀 32자. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** 대문자로 바꾸고 영숫자만 남긴다. 입력 중 하이픈/공백을 허용하기 위함. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}
