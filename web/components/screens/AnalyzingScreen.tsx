import { STAGE_LABELS } from "@/lib/data";
import { CheckIcon } from "../icons";

export type AnalyzedSummary = {
  chipsLabel: string;
  chips: string[];
  cards: Array<{ label: string; name: string; desc: string }>;
};

type Props = {
  demo?: boolean;
  stage: number;
  summary: AnalyzedSummary;
  error: string | null;
  onRetry: () => void;
};

const SKELETON_WIDTHS: Array<[string, string, string]> = [
  ["40%", "90%", "70%"],
  ["55%", "80%", "60%"],
  ["35%", "85%", "50%"],
  ["45%", "75%", "65%"],
];

export function AnalyzingScreen({ stage, summary, error, onRetry, demo=false }: Props) {
  const analyzed = stage >= STAGE_LABELS.length && !error;
  const title = error ? "분석을 완료하지 못했어요" : demo ? '저장된 예제를 불러오고 있어요' : analyzed ? "분석이 끝났어요" : "포트폴리오를 읽고 있어요";
  const subtitle = error ? "아래 안내를 확인하고 다시 시도해주세요" : demo ? '기존 생성 결과예요. 새 분석이나 모델 호출을 하지 않아요.' : analyzed ? "곧 준비 화면으로 넘어가요" : "예상 소요 시간 약 8분 · 문서에 따라 더 걸릴 수 있어요";
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">{title}</h2>
        <p className="screen-subtitle">{subtitle}</p>
      </div>
      <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div role="progressbar" aria-busy={!analyzed && !error} style={{ height: 8, borderRadius: 999, background: "#E4E4E7", overflow: "hidden", position: "relative" }}>
            {analyzed ? (
              <div style={{ position: "absolute", inset: 0, background: "#18181B", borderRadius: 999 }} />
            ) : error ? (
              <div style={{ position: "absolute", inset: 0, background: "#EF4444", borderRadius: 999, opacity: 0.5 }} />
            ) : (
              <div style={{ position: "absolute", top: 0, bottom: 0, width: "40%", background: "#18181B", borderRadius: 999, animation: "slide 1.4s ease-in-out infinite" }} />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 14, flexWrap: "wrap" }}>
            {STAGE_LABELS.map((label, i) => {
              const done = i < stage;
              const active = i === stage && !error;
              const reached = i <= stage;
              return (
                <span key={label} style={{ display: "flex", alignItems: "center", gap: 6, color: reached ? "#18181B" : "#A1A1AA", fontWeight: reached ? 500 : 400 }}>
                  {done && <CheckIcon size={14} strokeWidth={2.5} color="#18181B" />}
                  {active && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#18181B", animation: "pulse 1.2s infinite" }} />}
                  {label}
                </span>
              );
            })}
          </div>
        </div>

        {error && (
          <>
            <div className="error-box" role="alert">{error}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn-secondary focus-ring" onClick={onRetry}>
                다시 확인
              </button>
            </div>
          </>
        )}

        {!analyzed && !error && (
          <div className="two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} aria-hidden>
            {SKELETON_WIDTHS.map((widths, i) => (
              <div key={i} className="skeleton-card">
                <div className="skeleton-line" style={{ height: 14, width: widths[0] }} />
                <div className="skeleton-line" style={{ width: widths[1] }} />
                <div className="skeleton-line" style={{ width: widths[2] }} />
              </div>
            ))}
          </div>
        )}

        {analyzed && (
          <>
            {summary.chips.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn .4s ease-out" }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{summary.chipsLabel}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {summary.chips.map((s) => (
                    <span key={s} className="chip">{s}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "fadeIn .4s ease-out" }}>
              {summary.cards.map((p) => (
                <div key={p.name} style={{ border: "1px solid #E4E4E7", borderRadius: 8, padding: 20, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "#71717A" }}>{p.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 13, color: "#71717A", lineHeight: 1.5 }}>{p.desc}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
