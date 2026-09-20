export type RoleId = "designer" | "dev" | "mkt";

import type { Track } from "./types";
import type { ClientQuestion } from "./types";

/** 분석 코어가 지원하는 직무만 track이 있다. 없는 직무는 화면에서 선택 불가. */
export type Role = { id: RoleId; label: string; track: Track | null };

/** DB 예제와 실제 분석 결과를 같은 모양으로 표시한다. */
export type UiQuestion = {
  id: string;
  prompt: string;
  quotes: string[];
  notes: string[];
  source: string;
  anchors?: ClientQuestion['anchors'];
};

export const ROLES: Role[] = [
  { id: "designer", label: "디자이너", track: "design" },
  { id: "dev", label: "개발자", track: "coding" },
  { id: "mkt", label: "마케터", track: "marketing" },
];

export const STEP_LABELS = ["직무 선택", "업로드", "분석", "준비", "질문"] as const;

export const STAGE_LABELS = ["포트폴리오 읽는 중", "직무 핵심 내용 추출 중", "질문 만드는 중"] as const;

/** 기본으로 요청하는 질문 수. 실제 질문 수는 분석 결과에 따라 이보다 적을 수 있다. */
export { DEFAULT_MAX_QUESTIONS as DEFAULT_QUESTION_COUNT, ANSWER_MAX_LENGTH } from "../../src/constants.ts";

export function formatFileSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
