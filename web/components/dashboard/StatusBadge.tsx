import { STATUS_LABELS } from "@/lib/period";
import type { SubmissionState, TestStatus } from "@/lib/types";

const SUBMISSION_LABELS: Record<SubmissionState, string> = { joined: "진행 중", completed: "제출 완료" };

export function StatusBadge({ status }: { status: TestStatus | SubmissionState }) {
  const label = status in STATUS_LABELS ? STATUS_LABELS[status as TestStatus] : SUBMISSION_LABELS[status as SubmissionState];
  return <span className="badge" data-status={status}>{label}</span>;
}
