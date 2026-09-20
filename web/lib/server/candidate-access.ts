import type { PublicTest, TestRecord } from "../types.ts";
import { testStatus, formatDateTime } from "../period.ts";
import { findTestByCode } from "./store.ts";
import { ROLES } from "../data.ts";

export function publicTest(test: TestRecord): PublicTest {
  return {
    testId: test.id, title: test.title, startsAt: test.startsAt, endsAt: test.endsAt, mode: test.mode, totalSeconds: test.totalSeconds, questionCount: test.questionCount,
    role: test.role, roleLabel: ROLES.find((r) => r.id === test.role)?.label ?? test.role,
  };
}

/** 코드로 테스트를 찾고 지금 참여 가능한지 판단한다. */
export async function resolveOpenTest(rawCode: unknown, now = Date.now()): Promise<{ ok: true; test: TestRecord } | { ok: false; status: number; error: string }> {
  if (typeof rawCode !== "string") return { ok: false, status: 400, error: "코드를 입력해주세요." };
  const test = await findTestByCode(rawCode);
  if (!test) return { ok: false, status: 404, error: "코드를 찾을 수 없어요. 다시 확인해주세요." };
  const status = testStatus(test, now);
  if (status === "upcoming") return { ok: false, status: 403, error: `아직 시작 전인 테스트예요. 시작: ${formatDateTime(test.startsAt)}` };
  if (status === "closed") return { ok: false, status: 403, error: "종료된 테스트예요." };
  return { ok: true, test };
}
