export function Stat({ label, value, bordered }: { label: string; value: string; bordered?: boolean }) {
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
