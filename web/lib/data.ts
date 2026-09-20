import type { RoleId, Track, UiQuestion } from "./types.ts";

export type { RoleId, UiQuestion } from "./types.ts";

/** 분석 코어가 지원하는 직무만 track이 있다. 없는 직무는 화면에서 선택 불가. */
export type Role = { id: RoleId; label: string; track: Track | null };

export type Project = { name: string; desc: string };

export type Question = { text: string; project: string };

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

export const CANDIDATE_STEP_LABELS = ["코드 입력", "정보 입력", "직무 확인", ...STEP_LABELS.slice(1)] as const;

export const STAGE_LABELS = ["포트폴리오 읽는 중", "직무 핵심 내용 추출 중", "질문 만드는 중"] as const;

/** 기본으로 요청하는 질문 수. 실제 질문 수는 분석 결과에 따라 이보다 적을 수 있다. */
export const DEFAULT_QUESTION_COUNT = 10;
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
      q("온보딩 리디자인에서 첫 화면의 정보 우선순위를 어떻게 정했고, 무엇을 과감히 뺐나요?", "금융 앱 리디자인"),
      q("이탈률 개선 수치를 측정한 기간과 비교 기준은 무엇이었으며, 외부 요인은 어떻게 걸러냈나요?", "금융 앱 리디자인"),
      q("컴포넌트 48개 중 가장 논쟁이 컸던 컴포넌트는 무엇이었고, 최종 사양은 어떤 기준으로 정했나요?", "사내 디자인 시스템"),
      q("디자인 시스템 도입 후 팀별 사용률이나 일관성을 어떻게 측정했나요?", "사내 디자인 시스템"),
      q("금융 앱에서 신뢰감을 주기 위한 시각적 선택(색, 타이포, 여백)은 무엇이었고 어떤 대안을 검토했나요?", "금융 앱 리디자인"),
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
      q("LCP 측정은 어떤 환경과 도구로 했고, 실제 사용자 지표와는 어떻게 대조했나요?", "커머스 리뉴얼"),
      q("리뉴얼 중 기존 기능을 깨뜨리지 않기 위해 어떤 배포·롤백 전략을 썼나요?", "커머스 리뉴얼"),
      q("디자인 시스템 컴포넌트의 API를 설계할 때 유연성과 일관성 사이에서 어떤 기준으로 결정했나요?", "사내 디자인 시스템"),
      q("4개 팀이 같은 컴포넌트를 쓰면서 생긴 변경 요청은 어떤 절차로 조율했나요?", "사내 디자인 시스템"),
      q("번들 감소를 위해 제거하거나 교체한 라이브러리가 있다면 그 판단 근거는 무엇이었나요?", "커머스 리뉴얼"),
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
      q("CAC 34% 절감의 분모와 기간은 어떻게 잡았고, 계절성 같은 외부 요인은 어떻게 통제했나요?", "신규 가입 캠페인"),
      q("가입 캠페인의 핵심 메시지는 누구를 향한 것이었고, 검토했던 다른 메시지와 무엇이 달랐나요?", "신규 가입 캠페인"),
      q("리텐션 프로그램의 발송 채널과 빈도는 어떤 근거로 정했고, 피로도는 어떻게 관리했나요?", "CRM 리텐션 프로그램"),
      q("30일 리텐션 +12%p를 귀속하는 방식(대조군, 기간)은 무엇이었나요?", "CRM 리텐션 프로그램"),
      q("캠페인 예산을 채널별로 배분할 때 어떤 지표를 보고 조정했고, 중단한 채널이 있다면 이유는 무엇인가요?", "신규 가입 캠페인"),
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
