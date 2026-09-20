import { LogoutButton } from "./LogoutButton";

export function AccountMenu({ name, company }: { name: string; company?: string }) {
  return (
    <>
      <span style={{ fontSize: 14, color: "#3F3F46", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600, color: "#18181B" }}>{name}</span>{company ? ` · ${company}` : ""}
      </span>
      <LogoutButton />
    </>
  );
}
