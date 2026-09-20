import Link from "next/link";
import { Header } from "@/components/Header";
import { CreateTestForm } from "@/components/dashboard/CreateTestForm";
import { AccountMenu } from "@/components/dashboard/AccountMenu";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { requireAdmin } from "@/lib/server/session";
import { listTests } from "@/lib/server/store";
import { formatDateTime } from "@/lib/period";
import { ROLES } from "@/lib/data";

export const dynamic = "force-dynamic";

const roleLabel = (id: string) => ROLES.find((r) => r.id === id)?.label ?? id;

export default async function DashboardPage() {
  const account = await requireAdmin();
  const tests = await listTests();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={-1} steps={[]} right={<AccountMenu name={account.name} company={account.company} />} />
      <main className="dash-main">
        <div className="dash-title-row">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h1 className="screen-title">채용 테스트</h1>
            <p className="screen-subtitle">직무와 기간을 정해 테스트를 열고, 응시자에게 코드와 <code>/test</code> 주소를 알려주세요</p>
          </div>
        </div>
        <CreateTestForm />
        <div className="card">
          {tests.length === 0 ? (
            <div className="empty-state">아직 연 테스트가 없어요. 위에서 첫 테스트를 열어보세요.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>제목</th><th>직무</th><th>코드</th><th>기간</th><th>상태</th><th>제출</th><th>통과</th><th></th></tr>
                </thead>
                <tbody>
                  {tests.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 500 }}>{t.title}</td>
                      <td>{roleLabel(t.role)}</td>
                      <td><span className="code-pill">{t.code}</span></td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(t.startsAt)} ~ {formatDateTime(t.endsAt)}</td>
                      <td><StatusBadge status={t.status} /></td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{`${t.completedCount} / ${t.submissionCount}`}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{`${t.passedCount} / ${t.completedCount}`} <span className="field-hint">({t.passScore}점 기준)</span></td>
                      <td style={{ textAlign: "right" }}><Link href={`/tests/${t.id}`} className="table-link">보기</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
