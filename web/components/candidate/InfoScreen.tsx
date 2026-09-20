"use client";

import { useState, type FormEvent } from "react";
import { validateCandidate } from "@/lib/candidate";
import { formatDateTime } from "@/lib/period";
import type { PublicTest } from "@/lib/types";

type Props = { test: PublicTest; submitting: boolean; error: string | null; onSubmit: (info: { name: string; birthDate: string; phone: string; consent: true }) => void };

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
    onSubmit({ name, birthDate, phone, consent:true });
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
            <input id="cand-birth" type="date" className="text-input focus-ring" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} min="1900-01-01" max={new Date().toISOString().slice(0,10)} autoComplete="bday" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cand-phone">전화번호</label>
            <input id="cand-phone" className="text-input focus-ring" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-1234-5678" inputMode="tel" autoComplete="tel" required />
          </div>
        </div>
        <label className="notice-box"><input type="checkbox" required name="consent"/> 이 테스트의 담당자에게 응시 정보와 생성된 질문·답변을 공유하는 데 동의해요.
          응시 정보는 30일 보관해요. 원본 PDF·코드 파일은 공유하지 않아요.</label>
        {(localError ?? error) && <div className="error-box" role="alert">{localError ?? error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#71717A" }}>다음 화면에서 정해진 직무를 확인하고 포트폴리오를 올려요</span>
          <button type="submit" className="btn-primary focus-ring" disabled={submitting}>{submitting ? "확인 중..." : "시작하기"}</button>
        </div>
      </form>
    </div>
  );
}
