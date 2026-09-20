import Link from "next/link";
import { Header } from "@/components/Header";
import { SIGNUP_ERRORS, type SignupErrorCode } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ tab?: string; error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { tab, error } = await searchParams;
  const signup = tab === "signup";
  const signupError = signup && error ? (SIGNUP_ERRORS[error as SignupErrorCode] ?? "가입에 실패했어요. 다시 시도해주세요.") : null;
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={-1} steps={[]} />
      <main className="app-main">
        <div className="screen" style={{ alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", textAlign: "center" }}>
            <h2 className="screen-title">{signup ? "채용 담당자 회원가입" : "채용 담당자 로그인"}</h2>
            <p className="screen-subtitle">응시자는 로그인 없이 /test 에서 코드로 참여해요</p>
          </div>
          <div className="card login-card">
            <div role="tablist" className="login-tabs" aria-label="로그인 또는 회원가입">
              <Link href="/login" role="tab" aria-selected={!signup} className="tab-btn focus-ring" data-active={!signup}>로그인</Link>
              <Link href="/login?tab=signup" role="tab" aria-selected={signup} className="tab-btn focus-ring" data-active={signup}>회원가입</Link>
            </div>
            {!signup && (
              <form method="post" action="/api/admin/login" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {error === "1" && <div className="error-box" role="alert">이메일 또는 비밀번호가 맞지 않아요.</div>}
                <div className="field">
                  <label className="field-label" htmlFor="login-email">이메일</label>
                  <input id="login-email" name="email" type="email" className="text-input focus-ring" autoComplete="username" placeholder="name@company.com" required autoFocus />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="login-password">비밀번호</label>
                  <input id="login-password" name="password" type="password" className="text-input focus-ring" autoComplete="current-password" required />
                </div>
                <button type="submit" className="btn-primary focus-ring">로그인</button>
                <p className="link-row" style={{ margin: 0, textAlign: "center" }}>계정이 없다면 <Link href="/login?tab=signup">회원가입</Link></p>
              </form>
            )}
            {signup && (
              <form method="post" action="/api/admin/signup" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {signupError && <div className="error-box" role="alert">{signupError}</div>}
                <div className="field">
                  <label className="field-label" htmlFor="signup-email">이메일</label>
                  <input id="signup-email" name="email" type="email" className="text-input focus-ring" autoComplete="username" placeholder="name@company.com" required autoFocus />
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label className="field-label" htmlFor="signup-password">비밀번호</label>
                    <input id="signup-password" name="password" type="password" className="text-input focus-ring" autoComplete="new-password" minLength={8} required />
                    <span className="field-hint">8자 이상</span>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="signup-confirm">비밀번호 확인</label>
                    <input id="signup-confirm" name="passwordConfirm" type="password" className="text-input focus-ring" autoComplete="new-password" minLength={8} required />
                  </div>
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label className="field-label" htmlFor="signup-name">이름</label>
                    <input id="signup-name" name="name" className="text-input focus-ring" autoComplete="name" maxLength={40} required />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="signup-company">회사</label>
                    <input id="signup-company" name="company" className="text-input focus-ring" autoComplete="organization" maxLength={80} />
                  </div>
                </div>
                <button type="submit" className="btn-primary focus-ring">가입하고 시작하기</button>
                <p className="link-row" style={{ margin: 0, textAlign: "center" }}>이미 계정이 있다면 <Link href="/login">로그인</Link></p>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
