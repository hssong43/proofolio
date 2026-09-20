import { CheckIcon } from "../icons";

type Props = { roleLabel: string; answeredCount: number; questionCount: number; elapsed: string; saveError: string | null;
  saveState: "idle" | "saving" | "saved" | "failed"; onRetry: () => void; onHome: () => void };

export function CompleteScreen({ roleLabel, answeredCount, questionCount, elapsed, saveError, saveState, onRetry, onHome }: Props) {
  return (
    <div className="screen" style={{ alignItems: "center", animation: "fadeIn .3s ease-out" }}>
      <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#18181B", display: "grid", placeItems: "center" }}>
        <CheckIcon size={36} strokeWidth={2.5} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
        <h2 className="screen-title">{saveState === "saved" ? "저장 완료" : saveState === "saving" ? "저장 중" : saveState === "failed" ? "저장 실패" : "데모 완료"}</h2>
        <p className="screen-subtitle" style={{ lineHeight: 1.6 }}>
          답변 작성을 마쳤어요.
          <br />
          기업 전송과 자동 평가는 아직 지원하지 않아요.
        </p>
      </div>
      {saveError && <div className="error-box" role="alert" style={{ width: "100%" }}>답변 저장에 실패했어요: {saveError}</div>}
      {saveState === "failed" && <button type="button" className="btn-primary focus-ring" onClick={onRetry}>답변 저장 재시도</button>}
      <p role="status" style={{ margin: 0, textAlign: "center" }}>{saveState === "saved" ? "답변을 이 서버의 로컬 파일에 저장했어요." :
        saveState === "idle" ? "데모 답변은 서버에 저장하지 않아요." : "답변은 화면에 유지 중이에요. 저장이 끝날 때까지 창을 닫지 마세요."}</p>
      <div className="card" style={{ width: "100%", padding: 8, display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        <Stat label="직무" value={roleLabel} />
        <Stat label="답변한 질문 수" value={`${answeredCount} / ${questionCount}`} bordered />
        <Stat label="총 소요 시간" value={elapsed} />
      </div>
      <button type="button" className="btn-secondary focus-ring" disabled={saveState === "saving" || saveState === "failed"} onClick={onHome}>
        홈으로
      </button>
    </div>
  );
}

function Stat({ label, value, bordered }: { label: string; value: string; bordered?: boolean }) {
  return (
    <div
      style={{
        padding: "24px 8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        borderLeft: bordered ? "1px solid #E4E4E7" : undefined,
        borderRight: bordered ? "1px solid #E4E4E7" : undefined,
      }}
    >
      <span style={{ fontSize: 13, color: "#71717A" }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
