"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { DEFAULT_QUESTION_COUNT, ROLES, ROLE_DATA, STAGE_LABELS, demoQuestions, formatElapsed, formatFileSize, isValidLink, type RoleId, type UiQuestion } from "@/lib/data";
import { fetchStatus, startAnalysis, submitAnswers } from "@/lib/client";
import type { AnswerRecord, ClientResult } from "@/lib/types";
import { Header } from "./Header";
import { RoleScreen } from "./screens/RoleScreen";
import { UploadScreen, type UploadTab, type UploadedFile } from "./screens/UploadScreen";
import { AnalyzingScreen, type AnalyzedSummary } from "./screens/AnalyzingScreen";
import { ReadyScreen } from "./screens/ReadyScreen";
import { QuestionScreen } from "./screens/QuestionScreen";
import { CompleteScreen } from "./screens/CompleteScreen";

export type Screen = "role" | "upload" | "analyzing" | "ready" | "question" | "complete";

const STEP_INDEX: Record<Screen, number> = { role: 0, upload: 1, analyzing: 2, ready: 3, question: 4, complete: 5 };
const POLL_MS = 2000;
const READY_DELAY_MS = 1600;

type State = {
  screen: Screen;
  role: RoleId | null;
  tab: UploadTab;
  file: UploadedFile | null;
  link: string;
  submitting: boolean;
  uploadError: string | null;
  runId: string | null;
  stage: number;
  analysisError: string | null;
  summary: AnalyzedSummary;
  questions: UiQuestion[];
  questionIndex: number;
  answer: string;
  answers: AnswerRecord[];
  questionStartedAt: number;
  secondsLeft: number;
  startedAt: number;
  endedAt: number;
  saveError: string | null;
};

type Action =
  | { type: "selectRole"; role: RoleId }
  | { type: "goUpload" }
  | { type: "setTab"; tab: UploadTab }
  | { type: "setFile"; file: UploadedFile | null }
  | { type: "setLink"; link: string }
  | { type: "setSubmitting"; submitting: boolean }
  | { type: "uploadFailed"; error: string }
  | { type: "startAnalyze"; runId: string | null }
  | { type: "setStage"; stage: number }
  | { type: "analysisFailed"; error: string }
  | { type: "analyzed"; summary: AnalyzedSummary; questions: UiQuestion[] }
  | { type: "backToUpload" }
  | { type: "goReady" }
  | { type: "startQuestions"; totalSeconds: number; now: number }
  | { type: "tick" }
  | { type: "setAnswer"; answer: string }
  | { type: "submit"; totalSeconds: number; now: number }
  | { type: "saveFailed"; error: string }
  | { type: "reset"; totalSeconds: number };

const EMPTY_SUMMARY: AnalyzedSummary = { chipsLabel: "", chips: [], cards: [] };

const initialState = (totalSeconds: number): State => ({
  screen: "role",
  role: null,
  tab: "pdf",
  file: null,
  link: "",
  submitting: false,
  uploadError: null,
  runId: null,
  stage: 0,
  analysisError: null,
  summary: EMPTY_SUMMARY,
  questions: [],
  questionIndex: 0,
  answer: "",
  answers: [],
  questionStartedAt: 0,
  secondsLeft: totalSeconds,
  startedAt: 0,
  endedAt: 0,
  saveError: null,
});

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "selectRole":
      return { ...state, role: action.role };
    case "goUpload":
      return state.role ? { ...state, screen: "upload", uploadError: null } : state;
    case "setTab":
      return { ...state, tab: action.tab, uploadError: null };
    case "setFile":
      return { ...state, file: action.file, uploadError: null };
    case "setLink":
      return { ...state, link: action.link };
    case "setSubmitting":
      return { ...state, submitting: action.submitting };
    case "uploadFailed":
      return { ...state, submitting: false, uploadError: action.error };
    case "startAnalyze":
      return { ...state, screen: "analyzing", submitting: false, uploadError: null, runId: action.runId, stage: 0, analysisError: null, summary: EMPTY_SUMMARY, questions: [] };
    case "setStage":
      return { ...state, stage: Math.max(state.stage, action.stage) };
    case "analysisFailed":
      return { ...state, analysisError: action.error };
    case "analyzed":
      return { ...state, stage: STAGE_LABELS.length, summary: action.summary, questions: action.questions };
    case "backToUpload":
      return { ...state, screen: "upload", runId: null, stage: 0, analysisError: null };
    case "goReady":
      return state.questions.length ? { ...state, screen: "ready" } : { ...state, analysisError: "생성된 질문이 없어요. 다른 포트폴리오로 다시 시도해주세요." };
    case "startQuestions":
      return { ...state, screen: "question", questionIndex: 0, answer: "", answers: [], secondsLeft: action.totalSeconds, startedAt: action.now, questionStartedAt: action.now, endedAt: 0, saveError: null };
    case "tick":
      return { ...state, secondsLeft: Math.max(0, state.secondsLeft - 1) };
    case "setAnswer":
      return { ...state, answer: action.answer };
    case "submit": {
      const current = state.questions[state.questionIndex];
      const record: AnswerRecord = { questionId: current?.id ?? `q${state.questionIndex + 1}`, answer: state.answer, seconds: Math.round((action.now - state.questionStartedAt) / 1000) };
      const answers = [...state.answers, record];
      if (state.questionIndex >= state.questions.length - 1) {
        return { ...state, answers, screen: "complete", endedAt: action.now };
      }
      return { ...state, answers, questionIndex: state.questionIndex + 1, answer: "", secondsLeft: action.totalSeconds, questionStartedAt: action.now };
    }
    case "saveFailed":
      return { ...state, saveError: action.error };
    case "reset":
      return initialState(action.totalSeconds);
  }
}

function summaryFromResult(result: ClientResult): AnalyzedSummary {
  return {
    chipsLabel: "분석한 프로젝트",
    chips: result.projects.map((p) => p.title),
    cards: result.projects.map((p) => ({ label: "프로젝트", name: p.title, desc: `${p.pages.length}페이지 · 전체 ${result.pageCount}페이지 중` })),
  };
}

function questionsFromResult(result: ClientResult): UiQuestion[] {
  return result.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    quotes: q.quotes,
    notes: q.notes,
    source: `${q.projectTitle} · ${q.pages.join(", ")}페이지 근거`,
  }));
}

export type VerificationFlowProps = {
  /** 질문당 답변 시간(초). 기본 40. */
  totalSeconds?: number;
  /** 요청할 최대 질문 수. 기본 10. */
  questionCount?: number;
  /** true면 분석 코어 대신 목데이터로 흐름만 시연한다. */
  demo?: boolean;
  /** 데모 모드의 분석 대기 시간을 짧게 줄인다. */
  fastAnalysis?: boolean;
};

export function VerificationFlow({ totalSeconds = 40, questionCount = DEFAULT_QUESTION_COUNT, demo = false, fastAnalysis = false }: VerificationFlowProps) {
  const [state, dispatch] = useReducer(reducer, totalSeconds, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const roleInfo = ROLES.find((r) => r.id === state.role);
  const roleLabel = roleInfo?.label ?? "";
  const track = roleInfo?.track ?? null;
  const canAnalyze = demo ? (state.tab === "pdf" ? !!state.file : isValidLink(state.link)) : state.tab === "pdf" && !!state.file?.file && track !== null;

  const goUpload = useCallback(() => dispatch({ type: "goUpload" }), []);
  const startQuestions = useCallback(() => dispatch({ type: "startQuestions", totalSeconds, now: Date.now() }), [totalSeconds]);
  const submit = useCallback(() => dispatch({ type: "submit", totalSeconds, now: Date.now() }), [totalSeconds]);

  const startAnalyze = useCallback(async () => {
    const s = stateRef.current;
    if (demo) {
      dispatch({ type: "startAnalyze", runId: null });
      return;
    }
    const role = ROLES.find((r) => r.id === s.role);
    if (!role?.track || !s.file?.file) return;
    dispatch({ type: "setSubmitting", submitting: true });
    try {
      const { runId } = await startAnalysis(s.file.file, role.track, questionCount);
      dispatch({ type: "startAnalyze", runId });
    } catch (e) {
      dispatch({ type: "uploadFailed", error: (e as Error).message });
    }
  }, [demo, questionCount]);

  // 데모 모드 분석: 고정 시간 뒤 목데이터로 채운다
  useEffect(() => {
    if (state.screen !== "analyzing" || !demo) return;
    const data = ROLE_DATA[state.role ?? "dev"];
    const unit = fastAnalysis ? 350 : 1400;
    const timers = STAGE_LABELS.map((_, i) => window.setTimeout(() => dispatch({ type: "setStage", stage: i + 1 }), unit * (i + 1)));
    timers.push(
      window.setTimeout(() => {
        dispatch({
          type: "analyzed",
          summary: { chipsLabel: "추출된 핵심 역량", chips: data.skills, cards: data.projects.map((p) => ({ label: "프로젝트", ...p })) },
          questions: demoQuestions(data),
        });
      }, unit * STAGE_LABELS.length),
    );
    timers.push(window.setTimeout(() => dispatch({ type: "goReady" }), unit * STAGE_LABELS.length + (fastAnalysis ? 900 : 2200)));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [state.screen, state.role, demo, fastAnalysis]);

  // 실제 분석: 상태를 주기적으로 조회한다
  useEffect(() => {
    if (state.screen !== "analyzing" || demo || !state.runId) return;
    const runId = state.runId;
    let cancelled = false;
    let readyTimer: number | undefined;
    const poll = async () => {
      try {
        const status = await fetchStatus(runId);
        if (cancelled) return;
        if (status.state === "failed") {
          dispatch({ type: "analysisFailed", error: status.error ?? "분석이 완료되지 않았어요." });
          return;
        }
        if (status.state === "complete" && status.result) {
          dispatch({ type: "analyzed", summary: summaryFromResult(status.result), questions: questionsFromResult(status.result) });
          readyTimer = window.setTimeout(() => dispatch({ type: "goReady" }), READY_DELAY_MS);
          return;
        }
        dispatch({ type: "setStage", stage: status.stage });
        timer = window.setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!cancelled) dispatch({ type: "analysisFailed", error: (e as Error).message });
      }
    };
    let timer = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (readyTimer) window.clearTimeout(readyTimer);
    };
  }, [state.screen, state.runId, demo]);

  // 질문 화면: 1초 타이머, 0초가 되면 자동 제출
  useEffect(() => {
    if (state.screen !== "question") return;
    const id = window.setInterval(() => {
      if (stateRef.current.secondsLeft <= 1) submit();
      else dispatch({ type: "tick" });
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.screen, state.questionIndex, submit]);

  // 완료: 답변을 서버에 저장한다
  useEffect(() => {
    if (state.screen !== "complete" || !state.runId) return;
    submitAnswers(state.runId, state.answers).catch((e: Error) => dispatch({ type: "saveFailed", error: e.message }));
  }, [state.screen, state.runId, state.answers]);

  // 전역 Enter: 다음 단계로 진행
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const s = stateRef.current;
      if (tag === "TEXTAREA" || (tag === "INPUT" && s.screen !== "upload")) return;
      if (s.screen === "role" && s.role) goUpload();
      else if (s.screen === "upload" && !s.submitting) {
        const role = ROLES.find((r) => r.id === s.role);
        const ok = demo ? (s.tab === "pdf" ? !!s.file : isValidLink(s.link)) : s.tab === "pdf" && !!s.file?.file && !!role?.track;
        if (ok) void startAnalyze();
      } else if (s.screen === "ready") startQuestions();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [demo, goUpload, startAnalyze, startQuestions]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    dispatch({ type: "setFile", file: { name: file.name, size: formatFileSize(file.size), file } });
  };

  const elapsedSeconds = Math.max(0, Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000));
  const total = state.questions.length;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={STEP_INDEX[state.screen]} />
      <main className="app-main">
        {state.screen === "role" && <RoleScreen role={state.role} demo={demo} onSelect={(role) => dispatch({ type: "selectRole", role })} onNext={goUpload} />}
        {state.screen === "upload" && (
          <UploadScreen
            roleLabel={roleLabel}
            demo={demo}
            tab={state.tab}
            file={state.file}
            link={state.link}
            canAnalyze={canAnalyze}
            submitting={state.submitting}
            error={state.uploadError}
            onTabChange={(tab) => dispatch({ type: "setTab", tab })}
            onFile={onFile}
            onRemoveFile={() => dispatch({ type: "setFile", file: null })}
            onLinkChange={(link) => dispatch({ type: "setLink", link })}
            onAnalyze={() => void startAnalyze()}
          />
        )}
        {state.screen === "analyzing" && (
          <AnalyzingScreen stage={state.stage} summary={state.summary} error={state.analysisError} onRetry={() => dispatch({ type: "backToUpload" })} />
        )}
        {state.screen === "ready" && <ReadyScreen totalSeconds={totalSeconds} questionCount={total} onStart={startQuestions} />}
        {state.screen === "question" && (
          <QuestionScreen
            index={state.questionIndex}
            questionCount={total}
            question={state.questions[state.questionIndex]}
            answer={state.answer}
            secondsLeft={state.secondsLeft}
            totalSeconds={totalSeconds}
            chipsLabel={state.summary.chipsLabel}
            chips={state.summary.chips}
            onAnswerChange={(answer) => dispatch({ type: "setAnswer", answer })}
            onSubmit={submit}
          />
        )}
        {state.screen === "complete" && (
          <CompleteScreen
            roleLabel={roleLabel}
            answeredCount={state.answers.filter((a) => a.answer.trim()).length}
            questionCount={total}
            elapsed={formatElapsed(elapsedSeconds)}
            saveError={state.saveError}
            onHome={() => dispatch({ type: "reset", totalSeconds })}
          />
        )}
      </main>
    </div>
  );
}
