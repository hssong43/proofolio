export type RoleId = "designer" | "dev" | "mkt";

import type { Track } from "./types";

/** 분석 코어가 지원하는 직무만 track이 있다. 없는 직무는 화면에서 선택 불가. */
export type Role = { id: RoleId; label: string; track: Track | null };

export type Project = { name: string; desc: string };

export type Question = { text: string; project: string };

/** 화면에서 쓰는 질문 형태. 데모(목데이터)와 실제 분석 결과를 같은 모양으로 맞춘다. */
export type UiQuestion = {
  id: string;
  prompt: string;
  quotes: string[];
  notes: string[];
  source: string;
};

export function demoQuestions(data: RoleData): UiQuestion[] {
  return data.questions.map((q, i) => ({ id: `demo-q${i + 1}`, prompt: q.text, quotes: [], notes: [], source: `포트폴리오의 ${q.project} 프로젝트 기반` }));
}

export type RoleData = {
  skills: string[];
  projects: Project[];
  questions: Question[];
};

export const ROLES: Role[] = [
  { id: "designer", label: "디자이너", track: "design" },
  { id: "dev", label: "개발자", track: null },
  { id: "mkt", label: "마케터", track: "marketing" },
];

export const STEP_LABELS = ["직무 선택", "업로드", "분석", "준비", "질문"] as const;

export const STAGE_LABELS = ["포트폴리오 읽는 중", "직무 핵심 내용 추출 중", "질문 만드는 중"] as const;

/** 기본으로 요청하는 질문 수. 실제 질문 수는 분석 결과에 따라 이보다 적을 수 있다. */
export const DEFAULT_QUESTION_COUNT = 5;
export const ANSWER_MAX_LENGTH = 500;

const q = (text: string, project: string): Question => ({ text, project });

export const ROLE_DATA: Record<RoleId, RoleData> = {
  designer: {
    skills: ["UX 리서치", "디자인 시스템", "Figma", "프로토타이핑", "접근성", "데이터 기반 디자인"],
    projects: [
      { name: "금융 앱 리디자인", desc: "온보딩 이탈률 38% → 21%" },
      { name: "사내 디자인 시스템", desc: "컴포넌트 48개, 4개 팀 도입" },
    ],
    questions: [
      q("금융 앱 온보딩 이탈률을 38%에서 21%로 줄였다고 하셨는데, 어떤 리서치 근거로 개선 지점을 정했나요?", "금융 앱 리디자인"),
      q("디자인 시스템을 4개 팀에 도입하면서 가장 큰 반대 의견은 무엇이었고, 어떻게 설득하셨나요?", "사내 디자인 시스템"),
      q("프로토타입으로 검증했지만 결과가 가설과 달랐던 경험이 있다면 어떻게 대응하셨나요?", "금융 앱 리디자인"),
      q("접근성 기준을 적용하면서 시각적 완성도와 충돌했던 순간과 그 결정을 말해주세요.", "사내 디자인 시스템"),
      q("개발자와 협업할 때 디자인 의도가 잘 전달되도록 사용한 방법은 무엇인가요?", "사내 디자인 시스템"),
    ],
  },
  dev: {
    skills: ["React", "TypeScript", "성능 최적화", "디자인 시스템", "접근성", "테스트 자동화"],
    projects: [
      { name: "커머스 리뉴얼", desc: "LCP 4.2s → 1.8s, 번들 42% 감소" },
      { name: "사내 디자인 시스템", desc: "컴포넌트 48개, 4개 팀 도입" },
    ],
    questions: [
      q("커머스 리뉴얼에서 LCP를 4.2초에서 1.8초로 줄였다고 하셨는데, 가장 효과가 컸던 개선은 무엇이었나요?", "커머스 리뉴얼"),
      q("번들 크기를 42% 줄이는 과정에서 포기해야 했던 것은 무엇이었나요?", "커머스 리뉴얼"),
      q("디자인 시스템을 4개 팀에 도입하면서 가장 큰 반대 의견은 무엇이었고, 어떻게 설득하셨나요?", "사내 디자인 시스템"),
      q("테스트 자동화를 도입할 때 어디까지 테스트할지 기준을 어떻게 정하셨나요?", "사내 디자인 시스템"),
      q("접근성 이슈를 발견했지만 일정이 빠듯했던 상황에서 어떻게 우선순위를 정했나요?", "커머스 리뉴얼"),
    ],
  },
  mkt: {
    skills: ["퍼포먼스 마케팅", "CRM", "A/B 테스트", "콘텐츠 기획", "GA4", "브랜드 캠페인"],
    projects: [
      { name: "신규 가입 캠페인", desc: "CAC 34% 절감, 전환율 2.1배" },
      { name: "CRM 리텐션 프로그램", desc: "30일 리텐션 +12%p" },
    ],
    questions: [
      q("신규 가입 캠페인에서 CAC를 34% 절감했다고 하셨는데, 어떤 채널 조정이 가장 결정적이었나요?", "신규 가입 캠페인"),
      q("전환율 2.1배 개선 과정에서 실패한 A/B 테스트가 있었다면 무엇을 배웠나요?", "신규 가입 캠페인"),
      q("30일 리텐션을 12%p 올린 CRM 프로그램의 핵심 가설은 무엇이었나요?", "CRM 리텐션 프로그램"),
      q("데이터가 직관과 반대로 나왔을 때 어떻게 의사결정하셨나요?", "신규 가입 캠페인"),
      q("브랜드 메시지와 퍼포먼스 효율이 충돌할 때 어떤 기준으로 조율하셨나요?", "CRM 리텐션 프로그램"),
    ],
  },
};

export function formatFileSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

export function isValidLink(link: string) {
  return /^https?:\/\/\S+\.\S+/.test(link.trim());
}
