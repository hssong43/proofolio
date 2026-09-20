import { STEP_LABELS } from "@/lib/data";
import { CheckIcon, Logo } from "./icons";

type Props = { stepIndex: number };

export function Header({ stepIndex }: Props) {
  return (
    <header className="app-header">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Logo />
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.03em" }}>Proofolio</span>
      </div>
      <nav style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14 }} aria-label="진행 단계">
        {STEP_LABELS.map((label, i) => {
          const done = i < stepIndex;
          const current = i === stepIndex;
          const active = done || current;
          return (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  aria-current={current ? "step" : undefined}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    background: active ? "#18181B" : "#fff",
                    border: `1px solid ${active ? "#18181B" : "#E4E4E7"}`,
                    color: active ? "#fff" : "#71717A",
                  }}
                >
                  {done ? <CheckIcon /> : i + 1}
                </div>
                <span style={{ color: active ? "#18181B" : "#71717A", fontWeight: active ? 500 : 400 }}>{label}</span>
              </div>
              {i < STEP_LABELS.length - 1 && (
                <div style={{ width: 32, height: 1, background: done ? "#18181B" : "#E4E4E7" }} />
              )}
            </div>
          );
        })}
      </nav>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          aria-label="사용자"
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "#E4E4E7",
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "#3F3F46",
          }}
        >
          P
        </div>
      </div>
    </header>
  );
}
