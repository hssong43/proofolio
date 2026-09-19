"use client";

import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { ANSWER_MAX_LENGTH, type UiQuestion } from "@/lib/data";

const RING_RADIUS = 72;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const WARN_AT = 10;
const MIN_TEXTAREA_HEIGHT = 200;

type Props = {
  index: number;
  questionCount: number;
  question: UiQuestion;
  answer: string;
  secondsLeft: number;
  totalSeconds: number;
  chipsLabel: string;
  chips: string[];
  onAnswerChange: (value: string) => void;
  onSubmit: () => void;
};

export function QuestionScreen({ index, questionCount, question, answer, secondsLeft, totalSeconds, chipsLabel, chips, onAnswerChange, onSubmit }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isLast = index >= questionCount - 1;
  const warn = secondsLeft <= WARN_AT;
  const ringColor = warn ? "#EF4444" : "#18181B";

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
    const id = window.setTimeout(() => el.focus(), 50);
    return () => window.clearTimeout(id);
  }, [index]);

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    el.style.height = "0px";
    el.style.height = `${Math.max(MIN_TEXTAREA_HEIGHT, el.scrollHeight + 2)}px`;
    onAnswerChange(el.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="question-layout">
      <div key={index} style={{ display: "flex", flexDirection: "column", gap: 20, animation: `${index % 2 ? "slideB" : "slideA"} .2s ease-out` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#71717A", letterSpacing: ".04em" }}>
            Q{index + 1} / {questionCount}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} aria-hidden>
            {Array.from({ length: questionCount }, (_, i) => {
              const style =
                i < index
                  ? { background: "#18181B", border: "none", boxShadow: "none" }
                  : i === index
                    ? { background: "transparent", border: "2px solid #18181B", boxShadow: "0 0 0 2px #fff,0 0 0 3px #18181B" }
                    : { background: "transparent", border: "1px solid #D4D4D8", boxShadow: "none" };
              return <span key={i} style={{ width: 10, height: 10, borderRadius: "50%", ...style }} />;
            })}
          </div>
        </div>
        <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {question.quotes.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {question.quotes.map((quote, i) => (
                  <blockquote key={i} className="quote-box" style={{ margin: 0 }}>{quote}</blockquote>
                ))}
              </div>
            )}
            {question.notes.map((note, i) => (
              <p key={i} style={{ margin: 0, fontSize: 13, color: "#71717A" }}>{note}</p>
            ))}
            <h3 style={{ margin: 0, fontSize: 24, fontWeight: 600, lineHeight: 1.4, letterSpacing: "-.01em", textWrap: "pretty", whiteSpace: "pre-wrap" }}>{question.prompt}</h3>
            <p style={{ margin: 0, fontSize: 14, color: "#71717A" }}>{question.source}</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              ref={textareaRef}
              className="answer-textarea focus-ring"
              value={answer}
              onChange={onChange}
              onKeyDown={onKeyDown}
              maxLength={ANSWER_MAX_LENGTH}
              rows={1}
              placeholder="핵심 근거부터 짧게 적어주세요. Enter로 제출돼요"
              aria-label="답변"
            />
            <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 12, color: "#71717A", fontVariantNumeric: "tabular-nums" }}>
              {answer.length} / {ANSWER_MAX_LENGTH}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn-primary focus-ring" onClick={onSubmit}>
              {isLast ? "제출하고 완료" : "제출하고 다음"}
            </button>
          </div>
        </div>
      </div>

      <aside
        className="card question-aside"
        style={{ position: "sticky", top: 88, padding: "32px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}
      >
        <div style={{ position: "relative", width: 160, height: 160, animation: warn ? "pulse 1s ease-in-out infinite" : "none" }}>
          <svg width={160} height={160} viewBox="0 0 160 160" style={{ transform: "rotate(-90deg)" }} aria-hidden>
            <circle cx={80} cy={80} r={RING_RADIUS} fill="none" stroke="#E4E4E7" strokeWidth={8} />
            <circle
              cx={80}
              cy={80}
              r={RING_RADIUS}
              fill="none"
              stroke={ringColor}
              strokeWidth={8}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - secondsLeft / totalSeconds)}
              style={{ transition: "stroke-dashoffset 1s linear, stroke .3s" }}
            />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <span
              role="timer"
              aria-live={warn ? "assertive" : "off"}
              style={{ fontSize: 52, fontWeight: 600, letterSpacing: "-.03em", fontVariantNumeric: "tabular-nums", color: ringColor }}
            >
              {secondsLeft}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, textAlign: "center" }}>
          <span style={{ fontSize: 13, color: warn ? "#EF4444" : "#71717A", fontWeight: 500 }}>{warn ? "남은 시간 · 곧 자동 제출돼요" : "남은 시간"}</span>
          <span style={{ fontSize: 14, fontWeight: 500, color: "#18181B" }}>핵심 근거를 먼저 말해보세요</span>
        </div>
        {chips.length > 0 && (
          <>
            <div style={{ width: "100%", height: 1, background: "#E4E4E7" }} />
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#71717A", letterSpacing: ".06em" }}>{chipsLabel}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {chips.map((s) => (
                  <span key={s} className="chip chip-sm">{s}</span>
                ))}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
