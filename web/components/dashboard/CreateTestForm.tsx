"use client";

import { useState, type FormEvent } from "react";
import { ROLES, type RoleId } from "@/lib/data";

const pad = (n: number) => String(n).padStart(2, "0");
/** datetime-local 입력값 형식(로컬 시간). */
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function CreateTestForm({onCreated}:{onCreated:()=>void}) {
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<RoleId>("designer");
  const [questionCount, setQuestionCount] = useState("10");
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date()));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)));
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ title: string; code: string; roleLabel: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, role, questionCount: Number(questionCount), startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; test?: { title: string; code: string; role: RoleId } };
      if (!res.ok || !body.test) throw new Error(body.error ?? `요청 실패 (${res.status})`);
      setCreated({ title: body.test.title, code: body.test.code, roleLabel: ROLES.find((r) => r.id === body.test!.role)?.label ?? "" });
      setTitle("");
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>새 테스트 열기</div>
      <div className="field">
        <label className="field-label" htmlFor="test-title">제목</label>
        <input id="test-title" className="text-input focus-ring" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="예: 2026 하반기 디자이너 채용" required />
      </div>
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="test-role">직무</label>
          <select id="test-role" className="text-input focus-ring" value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <span className="field-hint">응시자는 이 직무가 맞는지 확인만 해요</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="test-count">목표 질문 수</label>
          <input id="test-count" type="number" min={6} max={10} step={1} className="text-input focus-ring" value={questionCount} onChange={(e) => setQuestionCount(e.target.value)} required />
          <span className="field-hint">근거가 부족하면 적게 생성돼요. 자동 채점·합불 판정은 하지 않아요.</span>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="test-start">시작</label>
          <input id="test-start" type="datetime-local" className="text-input focus-ring" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="test-end">종료</label>
          <input id="test-end" type="datetime-local" className="text-input focus-ring" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
        </div>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {created && (
        <div className="notice-box" role="status">
          <span>“{created.title}” ({created.roleLabel}) 테스트를 열었어요. 응시자에게 코드 <span className="code-pill">{created.code}</span>와 주소 <code>/test</code>를 알려주세요.</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="btn-primary focus-ring" disabled={submitting}>{submitting ? "여는 중..." : "테스트 열기"}</button>
      </div>
    </form>
  );
}
