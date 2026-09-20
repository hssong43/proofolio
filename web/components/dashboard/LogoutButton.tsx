export function LogoutButton() {
  return (
    <form method="post" action="/api/admin/logout">
      <button type="submit" className="btn-secondary focus-ring" style={{ height: 36, padding: "0 14px", fontSize: 14 }}>로그아웃</button>
    </form>
  );
}
