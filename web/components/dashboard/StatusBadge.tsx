import { STATUS_LABELS } from "@/lib/period";
import type { Submission, TestStatus } from "@/lib/types";

type Status = TestStatus | Submission['state'] | 'scoring' | 'failed';
const LABELS: Record<Status, string> = { ...STATUS_LABELS, joined: "진행 중", completed: "제출 완료", scoring: "채점 중", failed: "채점 실패" };

export function StatusBadge({ status }: { status: Status }) {
  return <span className="badge" data-status={status}>{LABELS[status]}</span>;
}
