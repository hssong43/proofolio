/** 쿼리 파라미터 정수를 범위 안에서만 받는다. */
export const intIn = (raw: string | undefined, min: number, max: number, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
