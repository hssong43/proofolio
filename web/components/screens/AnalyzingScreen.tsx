import { STAGE_LABELS, type RoleData } from "@/lib/data";
import { CheckIcon } from "../icons";

type Props = { stage: number; data: RoleData };

const SKELETON_WIDTHS: Array<[string, string, string]> = [
  ["40%", "90%", "70%"],
  ["55%", "80%", "60%"],
  ["35%", "85%", "50%"],
  ["45%", "75%", "65%"],
];

export function AnalyzingScreen({ stage, data }: Props) {
  const analyzed = stage >= STAGE_LABELS.length;
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">{analyzed ? "분석이 끝났어요" : "포트폴리오를 읽고 있어요"}</h2>
        <p className="screen-subtitle">{analyzed ? "곧 준비 화면으로 넘어가요" : "잠시만 기다려주세요. 보통 30초 정도 걸려요"}</p>
      </div>
      <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div role="progressbar" aria-busy={!analyzed} style={{ height: 8, borderRadius: 999, background: "#E4E4E7", overflow: "hidden", position: "relative" }}>
            {analyzed ? (
              <div style={{ position: "absolute", inset: 0, background: "#18181B", borderRadius: 999 }} />
            ) : (
              <div style={{ position: "absolute", top: 0, bottom: 0, width: "40%", background: "#18181B", borderRadius: 999, animation: "slide 1.4s ease-in-out infinite" }} />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 14, flexWrap: "wrap" }}>
            {STAGE_LABELS.map((label, i) => {
              const done = i < stage;
              const active = i === stage;
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

        {!analyzed && (
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
            <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn .4s ease-out" }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>추출된 핵심 역량</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {data.skills.map((s) => (
                  <span key={s} className="chip">{s}</span>
                ))}
              </div>
            </div>
            <div className="two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "fadeIn .4s ease-out" }}>
              {data.projects.map((p) => (
                <div key={p.name} style={{ border: "1px solid #E4E4E7", borderRadius: 8, padding: 20, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "#71717A" }}>프로젝트</div>
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
