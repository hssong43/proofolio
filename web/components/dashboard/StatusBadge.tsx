import { STATUS_LABELS } from "@/lib/period";
import type { Submission, TestStatus } from "@/lib/types";

type Status = TestStatus | Submission['state'];
const LABELS: Record<Status, string> = { ...STATUS_LABELS, joined: "진행 중", completed: "제출 완료" };

export function StatusBadge({ status }: { status: Status }) {
  return <span className="badge" data-status={status}>{LABELS[status]}</span>;
}
