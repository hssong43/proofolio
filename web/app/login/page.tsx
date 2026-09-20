import { Header } from "@/components/Header";
import { adminConfigured } from "@/lib/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;
  const configured = adminConfigured();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={-1} steps={[]} />
      <main className="app-main">
        <div className="screen" style={{ alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", textAlign: "center" }}>
            <h2 className="screen-title">채용 담당자 로그인</h2>
            <p className="screen-subtitle">응시자는 로그인 없이 /test 에서 코드로 참여해요</p>
          </div>
          <form method="post" action="/api/admin/login" className="card login-card">
            {!configured && <div className="error-box" role="alert">서버에 PROOFOLIO_ADMIN_PASSWORD가 설정되지 않았어요. 루트 .env 또는 환경변수에 넣고 서버를 다시 시작해주세요.</div>}
            {error === "1" && <div className="error-box" role="alert">비밀번호가 맞지 않아요.</div>}
            {error === "env" && <div className="error-box" role="alert">서버 비밀번호 설정이 없어 로그인할 수 없어요.</div>}
            <div className="field">
              <label className="field-label" htmlFor="password">비밀번호</label>
              <input id="password" name="password" type="password" className="text-input focus-ring" autoComplete="current-password" required autoFocus />
            </div>
            <button type="submit" className="btn-primary focus-ring" disabled={!configured}>로그인</button>
          </form>
        </div>
      </main>
    </div>
  );
}
