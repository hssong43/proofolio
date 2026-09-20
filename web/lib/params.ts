/** 쿼리 파라미터 정수를 범위 안에서만 받는다. */
export const intIn = (raw: string | undefined, min: number, max: number, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function safeReturnPath(raw: string | undefined): string | undefined {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw)) return undefined;
  const url = new URL(raw, 'https://proofolio.invalid');
  return /^\/(dashboard|test|tests\/[a-f0-9-]+(?:\/submissions\/[a-f0-9-]+)?)$/.test(url.pathname)
    ? url.pathname + url.search : undefined;
}
