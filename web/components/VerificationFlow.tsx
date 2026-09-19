"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { QUESTION_COUNT, ROLES, ROLE_DATA, STAGE_LABELS, formatElapsed, formatFileSize, isValidLink, type RoleId } from "@/lib/data";
import { Header } from "./Header";
import { RoleScreen } from "./screens/RoleScreen";
import { UploadScreen, type UploadTab, type UploadedFile } from "./screens/UploadScreen";
import { AnalyzingScreen } from "./screens/AnalyzingScreen";
import { ReadyScreen } from "./screens/ReadyScreen";
import { QuestionScreen } from "./screens/QuestionScreen";
import { CompleteScreen } from "./screens/CompleteScreen";

export type Screen = "role" | "upload" | "analyzing" | "ready" | "question" | "complete";

const STEP_INDEX: Record<Screen, number> = { role: 0, upload: 1, analyzing: 2, ready: 3, question: 4, complete: 5 };

type State = {
  screen: Screen;
  role: RoleId | null;
  tab: UploadTab;
  file: UploadedFile | null;
  link: string;
  stage: number;
  questionIndex: number;
  answer: string;
  answers: string[];
  secondsLeft: number;
  startedAt: number;
  endedAt: number;
};

type Action =
  | { type: "selectRole"; role: RoleId }
  | { type: "goUpload" }
  | { type: "setTab"; tab: UploadTab }
  | { type: "setFile"; file: UploadedFile | null }
  | { type: "setLink"; link: string }
  | { type: "startAnalyze" }
  | { type: "setStage"; stage: number }
  | { type: "goReady" }
  | { type: "startQuestions"; totalSeconds: number; now: number }
  | { type: "tick" }
  | { type: "setAnswer"; answer: string }
  | { type: "submit"; totalSeconds: number; now: number }
  | { type: "reset"; totalSeconds: number };

const initialState = (totalSeconds: number): State => ({
  screen: "role",
  role: null,
  tab: "pdf",
  file: null,
  link: "",
  stage: 0,
  questionIndex: 0,
  answer: "",
  answers: [],
  secondsLeft: totalSeconds,
  startedAt: 0,
  endedAt: 0,
});

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "selectRole":
      return { ...state, role: action.role };
    case "goUpload":
      return state.role ? { ...state, screen: "upload" } : state;
    case "setTab":
      return { ...state, tab: action.tab };
    case "setFile":
      return { ...state, file: action.file };
    case "setLink":
      return { ...state, link: action.link };
    case "startAnalyze":
      return { ...state, screen: "analyzing", stage: 0 };
    case "setStage":
      return { ...state, stage: action.stage };
    case "goReady":
      return { ...state, screen: "ready" };
    case "startQuestions":
      return { ...state, screen: "question", questionIndex: 0, answer: "", answers: [], secondsLeft: action.totalSeconds, startedAt: action.now, endedAt: 0 };
    case "tick":
      return { ...state, secondsLeft: Math.max(0, state.secondsLeft - 1) };
    case "setAnswer":
      return { ...state, answer: action.answer };
    case "submit": {
      const answers = [...state.answers, state.answer];
      if (state.questionIndex >= QUESTION_COUNT - 1) {
        return { ...state, answers, screen: "complete", endedAt: action.now };
      }
      return { ...state, answers, questionIndex: state.questionIndex + 1, answer: "", secondsLeft: action.totalSeconds };
    }
    case "reset":
      return initialState(action.totalSeconds);
  }
}

export type VerificationFlowProps = {
  /** 질문당 답변 시간(초). 기본 40. */
  totalSeconds?: number;
  /** 분석 단계 대기 시간을 짧게 줄인다(데모용). */
  fastAnalysis?: boolean;
};

export function VerificationFlow({ totalSeconds = 40, fastAnalysis = false }: VerificationFlowProps) {
  const [state, dispatch] = useReducer(reducer, totalSeconds, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const canAnalyze = state.tab === "pdf" ? !!state.file : isValidLink(state.link);
  const roleLabel = ROLES.find((r) => r.id === state.role)?.label ?? "";
  const data = ROLE_DATA[state.role ?? "dev"];

  const goUpload = useCallback(() => dispatch({ type: "goUpload" }), []);
  const startAnalyze = useCallback(() => dispatch({ type: "startAnalyze" }), []);
  const startQuestions = useCallback(() => dispatch({ type: "startQuestions", totalSeconds, now: Date.now() }), [totalSeconds]);
  const submit = useCallback(() => dispatch({ type: "submit", totalSeconds, now: Date.now() }), [totalSeconds]);

  // 분석 화면: 단계 전환 후 준비 화면으로 이동
  useEffect(() => {
    if (state.screen !== "analyzing") return;
    const unit = fastAnalysis ? 350 : 1400;
    const timers = STAGE_LABELS.map((_, i) => window.setTimeout(() => dispatch({ type: "setStage", stage: i + 1 }), unit * (i + 1)));
    timers.push(window.setTimeout(() => dispatch({ type: "goReady" }), unit * STAGE_LABELS.length + (fastAnalysis ? 900 : 2200)));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [state.screen, fastAnalysis]);

  // 질문 화면: 1초 타이머, 0초가 되면 자동 제출
  useEffect(() => {
    if (state.screen !== "question") return;
    const id = window.setInterval(() => {
      if (stateRef.current.secondsLeft <= 1) submit();
      else dispatch({ type: "tick" });
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.screen, state.questionIndex, submit]);

  // 전역 Enter: 다음 단계로 진행
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const s = stateRef.current;
      if (tag === "TEXTAREA" || (tag === "INPUT" && s.screen !== "upload")) return;
      if (s.screen === "role" && s.role) goUpload();
      else if (s.screen === "upload" && (s.tab === "pdf" ? !!s.file : isValidLink(s.link))) startAnalyze();
      else if (s.screen === "ready") startQuestions();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goUpload, startAnalyze, startQuestions]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    dispatch({ type: "setFile", file: { name: file.name, size: formatFileSize(file.size) } });
  };

  const elapsedSeconds = Math.max(0, Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000));

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={STEP_INDEX[state.screen]} />
      <main className="app-main">
        {state.screen === "role" && <RoleScreen role={state.role} onSelect={(role) => dispatch({ type: "selectRole", role })} onNext={goUpload} />}
        {state.screen === "upload" && (
          <UploadScreen
            roleLabel={roleLabel}
            tab={state.tab}
            file={state.file}
            link={state.link}
            canAnalyze={canAnalyze}
            onTabChange={(tab) => dispatch({ type: "setTab", tab })}
            onFile={onFile}
            onRemoveFile={() => dispatch({ type: "setFile", file: null })}
            onLinkChange={(link) => dispatch({ type: "setLink", link })}
            onAnalyze={startAnalyze}
          />
        )}
        {state.screen === "analyzing" && <AnalyzingScreen stage={state.stage} data={data} />}
        {state.screen === "ready" && <ReadyScreen totalSeconds={totalSeconds} onStart={startQuestions} />}
        {state.screen === "question" && (
          <QuestionScreen
            index={state.questionIndex}
            question={data.questions[state.questionIndex]}
            answer={state.answer}
            secondsLeft={state.secondsLeft}
            totalSeconds={totalSeconds}
            skills={data.skills}
            onAnswerChange={(answer) => dispatch({ type: "setAnswer", answer })}
            onSubmit={submit}
          />
        )}
        {state.screen === "complete" && (
          <CompleteScreen
            roleLabel={roleLabel}
            answeredCount={state.answers.filter((a) => a.trim()).length}
            elapsed={formatElapsed(elapsedSeconds)}
            onHome={() => dispatch({ type: "reset", totalSeconds })}
          />
        )}
      </main>
    </div>
  );
}
