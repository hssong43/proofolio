"use client";

import { useState, type FormEvent } from "react";
import { validateCandidate } from "@/lib/candidate";
import { formatDateTime } from "@/lib/period";
import type { PublicTest } from "@/lib/types";

type Props = { test: PublicTest; submitting: boolean; error: string | null; onSubmit: (info: { name: string; birthDate: string; phone: string }) => void };

export function InfoScreen({ test, submitting, error, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [phone, setPhone] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = validateCandidate({ name, birthDate, phone });
    if (!checked.ok) {
      setLocalError(checked.error);
      return;
    }
    setLocalError(null);
    onSubmit({ name, birthDate, phone });
  };

  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">응시자 정보를 입력해주세요</h2>
        <p className="screen-subtitle">{test.title} · {test.roleLabel} · {formatDateTime(test.startsAt)} ~ {formatDateTime(test.endsAt)}</p>
      </div>
      <form onSubmit={submit} className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
        <div className="field">
          <label className="field-label" htmlFor="cand-name">이름</label>
          <input id="cand-name" className="text-input focus-ring" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="name" required autoFocus />
        </div>
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="cand-birth">생년월일</label>
            <input id="cand-birth" className="text-input focus-ring" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} placeholder="YYYY-MM-DD" inputMode="numeric" autoComplete="bday" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cand-phone">전화번호</label>
            <input id="cand-phone" className="text-input focus-ring" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-1234-5678" inputMode="tel" autoComplete="tel" required />
          </div>
        </div>
        {(localError ?? error) && <div className="error-box" role="alert">{localError ?? error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#71717A" }}>다음 화면에서 직무를 고르고 포트폴리오를 올려요</span>
          <button type="submit" className="btn-primary focus-ring" disabled={submitting}>{submitting ? "확인 중..." : "시작하기"}</button>
        </div>
      </form>
    </div>
  );
}
