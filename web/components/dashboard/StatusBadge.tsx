import { STATUS_LABELS } from "@/lib/period";
import type { SubmissionState, TestStatus } from "@/lib/types";

type Status = TestStatus | SubmissionState | "passed" | "failed";
const LABELS: Record<Status, string> = { ...STATUS_LABELS, joined: "진행 중", completed: "제출 완료", passed: "통과", failed: "미통과" };

export function StatusBadge({ status }: { status: Status }) {
  return <span className="badge" data-status={status}>{LABELS[status]}</span>;
}
