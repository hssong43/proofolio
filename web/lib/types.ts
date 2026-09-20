export type Track = "design" | "marketing";

export type RunState = "queued" | "running" | "complete" | "failed";

export type ClientQuestion = {
  id: string;
  /** 질문 본문(마지막 줄). */
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
};

export type AnswerRecord = { questionId: string; answer: string; seconds: number };

/* ---------- 채용 테스트 / 응시자 (mock 단계) ---------- */

export type RoleId = "designer" | "dev" | "mkt";

/** 화면에서 쓰는 질문 형태. 데모(목데이터)와 실제 분석 결과를 같은 모양으로 맞춘다. */
export type UiQuestion = {
  id: string;
  prompt: string;
  quotes: string[];
  notes: string[];
  source: string;
};

export type TestStatus = "upcoming" | "open" | "closed";
export type AnalysisMode = "demo" | "live";

export type TestRecord = {
  id: string;
  code: string;
  title: string;
  /** 담당자가 테스트 생성 시 정한 직무. 응시자는 확인만 한다. */
  role: RoleId;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  createdBy?: string;
  totalSeconds: number;
  questionCount: number;
  /** 종합 점수가 이 값 이상이면 통과. 0~100. */
  passScore: number;
  /** demo: 목데이터 분석, live: 실제 분석 코어(추후). */
  mode: AnalysisMode;
};

export type TestSummary = TestRecord & { status: TestStatus; submissionCount: number; completedCount: number; passedCount: number };

export type Candidate = { name: string; birthDate: string; phone: string };

export type SubmissionState = "joined" | "completed";

export type Submission = {
  id: string;
  testId: string;
  candidate: Candidate;
  state: SubmissionState;
  joinedAt: string;
  completedAt?: string;
  role?: RoleId;
  roleLabel?: string;
  /** 응시자가 실제로 본 질문 스냅샷. */
  questions?: UiQuestion[];
  answers?: AnswerRecord[];
  elapsedSeconds?: number;
  runId?: string | null;
  evaluation?: Evaluation;
};

export type EvaluationItem = { questionId: string; score: number; comment: string; signals: string[] };

export type Evaluation = {
  method: "mock-rules";
  version: 1;
  passScore: number;
  overallScore: number;
  passed: boolean;
  items: EvaluationItem[];
  evaluatedAt: string;
};

export type Account = { id: string; email: string; name: string; company: string; passwordHash: string; createdAt: string };

export type CompletionPayload = {
  role: RoleId;
  roleLabel: string;
  questions: UiQuestion[];
  answers: AnswerRecord[];
  elapsedSeconds: number;
  runId: string | null;
};

/** 응시자에게 노출하는 테스트 요약. */
export type PublicTest = Pick<TestRecord, "title" | "startsAt" | "endsAt" | "mode" | "totalSeconds" | "questionCount" | "role"> & { testId: string; roleLabel: string };
