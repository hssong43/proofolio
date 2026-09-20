export type Track = "design" | "marketing" | "coding";

export type SourceAsset = { id: string; page: number; box?: [number, number, number, number]; kind: "page" | "crop" | "pdf" | "code"; path?: string };

export type RunState = "queued" | "running" | "complete" | "failed";

export type ClientQuestion = {
  id: string;
  /** 인용을 분리한 전체 질문 본문(다중행 보존). */
  prompt: string;
  /** 검증된 원문 인용. */
  quotes: string[];
  /** 인용 외 안내 문구(예: 시각 자료 기준). */
  notes: string[];
  pages: number[];
  projectTitle: string;
  intent: string;
  listenFor: string[];
  answerTarget: string;
  anchors?: Array<{ page: number; box?: [number, number, number, number]; assetId: string }>;
};

export type ClientProject = { key: string; title: string; pages: number[] };

export type ClientResult = {
  status: string;
  qualityIssues: string[];
  pageCount: number;
  projects: ClientProject[];
  evidenceCount: number;
  questions: ClientQuestion[];
  estimatedCostUsd: number;
  maxQuestions: number;
  sourceAssets?: SourceAsset[];
  exampleNotice?: string;
};

export type RunStatus = {
  runId: string;
  track: Track;
  fileName: string;
  state: RunState;
  /** 0 읽는 중, 1 추출 중, 2 질문 생성 중, 3 완료 */
  stage: number;
  lastEvent?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  result?: ClientResult;
  storage?: "local" | "supabase";
  storageError?: string;
  answers?: AnswerRecord[];
};

export type AnswerRecord = { questionId: string; answer: string; seconds: number };
