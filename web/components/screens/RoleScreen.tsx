import { ROLES, type RoleId } from "@/lib/data";
import { CheckIcon, CodeIcon, MegaphoneIcon, PaletteIcon } from "../icons";

type Props = {
  role: RoleId | null;
  onSelect: (role: RoleId) => void;
  onNext: () => void;
};

const ICONS: Record<RoleId, () => React.JSX.Element> = {
  designer: () => <PaletteIcon />,
  dev: () => <CodeIcon />,
  mkt: () => <MegaphoneIcon />,
};

export function RoleScreen({ role, onSelect, onNext }: Props) {
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">어떤 직무로 검증받을까요?</h2>
        <p className="screen-subtitle">직무에 맞춰 질문이 달라져요</p>
      </div>
      <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 32 }}>
        <div className="role-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
          {ROLES.map((r) => {
            const Icon = ICONS[r.id];
            const selected = role === r.id;
            return (
              <button
                key={r.id}
                type="button"
                className="role-card focus-ring"
                data-selected={selected}
                aria-pressed={selected}
                onClick={() => onSelect(r.id)}
              >
                <Icon />
                {selected && (
                  <CheckIcon size={20} strokeWidth={2.5} color="#18181B" style={{ position: "absolute", top: 16, right: 16 }} />
                )}
                <span style={{ fontSize: 18, fontWeight: 600, color: "#18181B" }}>{r.label}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn-primary focus-ring" disabled={!role} onClick={onNext}>
            다음
          </button>
        </div>
      </div>
    </div>
  );
}
