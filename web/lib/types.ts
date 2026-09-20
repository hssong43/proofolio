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
  execution?: 'local' | 'steps';
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

export type ExampleAnswer = { questionId: string; answer: string };
export type ExampleImage = { page: number; url: string };
export type ExampleScores = { overallScore: number; items: Array<{ questionId: string; score: number }> };
export type PortfolioExample = { title: string; notice: string; result: ClientResult; sampleAnswers: ExampleAnswer[]; sampleScores?: ExampleScores | null; images: ExampleImage[]; portfolioUrl: string | null };

export type { RoleId, UiQuestion } from './data.ts';
export type TestStatus = 'upcoming' | 'open' | 'closed';
export type Candidate = { name: string; birthDate: string; phone: string };
export type TestRecord = {
  id: string; code: string; title: string; role: import('./data.ts').RoleId;
  startsAt: string; endsAt: string; createdAt: string; totalSeconds: number; questionCount: number;
};
export type TestSummary = TestRecord & { status: TestStatus; submissionCount: number; completedCount: number; scoredCount: number; averageScore: number | null };
export type ScoreState = 'pending' | 'running' | 'complete' | 'failed';
export type ScoreCoverage = { item: string; covered: boolean; evidence: string };
export type ScoreItem = {
  questionId: string; score: number; coverageScore: number; bonus: number; relevance: 'none' | 'partial' | 'full';
  coverage: ScoreCoverage[]; missing: string[]; depth: number; logic: number; creativity: number; comment: string;
};
/** AI 답변 채점 결과. 참고 지표이며 합불 판정이 아니다. */
export type SubmissionScore = {
  state: ScoreState; model: string | null; overallScore: number | null; items: ScoreItem[];
  error: string | null; scoredAt: string | null; costUsd: number | null;
};
export type PublicTest = Omit<TestRecord, 'id' | 'code' | 'createdAt'> & { testId: string; roleLabel: string };
export type Submission = {
  id: string; testId: string; candidate: Candidate; joinedAt: string; completedAt: string | null;
  state: 'joined' | 'completed'; runId: string | null; score?: SubmissionScore | null;
};
export type SubmissionDetail = { submission: Submission; test: TestRecord; run: RunStatus | null };
