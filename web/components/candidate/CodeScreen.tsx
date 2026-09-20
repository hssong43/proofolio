"use client";

import { useState, type FormEvent } from "react";
import { isValidCode, normalizeCode } from "@/lib/codes";

type Props = { submitting: boolean; error: string | null; onSubmit: (code: string) => void };

export function CodeScreen({ submitting, error, onSubmit }: Props) {
  const [code, setCode] = useState("");
  const valid = isValidCode(code);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && !submitting) onSubmit(code);
  };
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">참여 코드를 입력해주세요</h2>
        <p className="screen-subtitle">채용 담당자에게 받은 6자리 코드예요</p>
      </div>
      <form onSubmit={submit} className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
        <div className="field">
          <label className="field-label" htmlFor="join-code">참여 코드</label>
          <input
            id="join-code"
            className="text-input code-input focus-ring"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            maxLength={12}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ABC234"
            aria-label="참여 코드"
            autoFocus
          />
          <span className="field-hint">영문 대문자와 숫자 6자리. 대소문자는 구분하지 않아요.</span>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="btn-primary focus-ring" disabled={!valid || submitting}>{submitting ? "확인 중..." : "다음"}</button>
        </div>
      </form>
    </div>
  );
}
