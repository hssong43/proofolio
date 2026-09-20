import type { TestStatus } from "./types.ts";

const parse = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function testStatus(test: { startsAt: string; endsAt: string }, now = Date.now()): TestStatus {
  const start = parse(test.startsAt) ?? Number.POSITIVE_INFINITY;
  const end = parse(test.endsAt) ?? Number.NEGATIVE_INFINITY;
  if (now < start) return "upcoming";
  if (now > end) return "closed";
  return "open";
}

/** 유효하면 정규화된 ISO 문자열 쌍, 아니면 오류 메시지를 돌려준다. */
export function validatePeriod(startsAt: unknown, endsAt: unknown): { ok: true; startsAt: string; endsAt: string } | { ok: false; error: string } {
  if (typeof startsAt !== "string" || typeof endsAt !== "string") return { ok: false, error: "시작과 종료 시각이 필요해요." };
  const start = parse(startsAt), end = parse(endsAt);
  if (start === null || end === null) return { ok: false, error: "시각 형식이 올바르지 않아요." };
  if (end <= start) return { ok: false, error: "종료 시각은 시작 시각보다 뒤여야 해요." };
  return { ok: true, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

const formatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** 서버·클라이언트 어디서 렌더해도 같은 결과가 나오도록 시간대를 고정한다. */
export function formatDateTime(iso: string): string {
  const t = parse(iso);
  return t === null ? "-" : formatter.format(new Date(t)).replace(/\.\s?/g, ".").replace(/\.$/, "").replace(/\.(\d{2}:)/, " $1");
}

export const STATUS_LABELS: Record<TestStatus, string> = { upcoming: "시작 전", open: "진행 중", closed: "종료" };
