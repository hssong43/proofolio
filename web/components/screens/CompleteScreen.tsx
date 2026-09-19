import { QUESTION_COUNT } from "@/lib/data";
import { CheckIcon } from "../icons";

type Props = { roleLabel: string; answeredCount: number; elapsed: string; onHome: () => void };

export function CompleteScreen({ roleLabel, answeredCount, elapsed, onHome }: Props) {
  return (
    <div className="screen" style={{ alignItems: "center", animation: "fadeIn .3s ease-out" }}>
      <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#18181B", display: "grid", placeItems: "center" }}>
        <CheckIcon size={36} strokeWidth={2.5} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
        <h2 className="screen-title">완료되었습니다</h2>
        <p className="screen-subtitle" style={{ lineHeight: 1.6 }}>
          답변이 기업에게 전달되었어요.
          <br />
          수고하셨습니다.
        </p>
      </div>
      <div className="card" style={{ width: "100%", padding: 8, display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        <Stat label="직무" value={roleLabel} />
        <Stat label="답변한 질문 수" value={`${answeredCount} / ${QUESTION_COUNT}`} bordered />
        <Stat label="총 소요 시간" value={elapsed} />
      </div>
      <button type="button" className="btn-secondary focus-ring" onClick={onHome}>
        홈으로
      </button>
    </div>
  );
}

function Stat({ label, value, bordered }: { label: string; value: string; bordered?: boolean }) {
  return (
    <div
      style={{
        padding: 24,
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
