"use client";

import { useState } from "react";
import { CodeIcon, MegaphoneIcon, PaletteIcon } from "../icons";
import type { RoleId } from "@/lib/data";

const ICONS: Record<RoleId, () => React.JSX.Element> = {
  designer: () => <PaletteIcon size={40} />,
  dev: () => <CodeIcon size={40} />,
  mkt: () => <MegaphoneIcon size={40} />,
};

type Props = { role: RoleId; roleLabel: string; testTitle: string; onConfirm: () => void };

export function RoleConfirmScreen({ role, roleLabel, testTitle, onConfirm }: Props) {
  const [declined, setDeclined] = useState(false);
  const Icon = ICONS[role];
  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 className="screen-title">지원 직무를 확인해주세요</h2>
        <p className="screen-subtitle">{testTitle}</p>
      </div>
      <div className="card" style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "20px 24px", border: "1px solid #E4E4E7", borderRadius: 8 }}>
          <Icon />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "#71717A" }}>이 테스트의 직무</span>
            <span style={{ fontSize: 22, fontWeight: 600 }}>{roleLabel}</span>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
          이 테스트는 <strong>{roleLabel}</strong> 직무 검증이에요. 본인이 지원한 직무가 맞나요? 직무는 채용 담당자가 정한 것으로, 여기서 바꿀 수 없어요.
        </p>
        {declined && (
          <div className="notice-box" role="status">
            지원한 직무와 다르다면 채용 담당자에게 연락해 참여 코드를 다시 확인해주세요. 확인이 끝나면 다시 코드부터 진행하면 돼요.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
          {declined ? (
            <button type="button" className="btn-secondary focus-ring" onClick={() => setDeclined(false)}>다시 확인</button>
          ) : (
            <button type="button" className="btn-secondary focus-ring" onClick={() => setDeclined(true)}>아니에요</button>
          )}
          <button type="button" className="btn-primary focus-ring" onClick={onConfirm} disabled={declined}>맞아요, 계속</button>
        </div>
      </div>
    </div>
  );
}
