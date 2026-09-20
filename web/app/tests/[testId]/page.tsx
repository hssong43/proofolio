import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { LogoutButton } from "@/components/dashboard/LogoutButton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { requireAdmin } from "@/lib/server/session";
import { getTest, listSubmissions } from "@/lib/server/store";
import { formatDateTime, testStatus } from "@/lib/period";
import { formatPhone } from "@/lib/candidate";

export const dynamic = "force-dynamic";

export default async function TestDetailPage({ params }: { params: Promise<{ testId: string }> }) {
  await requireAdmin();
  const { testId } = await params;
  const test = await getTest(testId).catch(() => null);
  if (!test) notFound();
  const submissions = await listSubmissions(test.id);
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={-1} steps={[]} right={<LogoutButton />} />
      <main className="dash-main">
        <div className="breadcrumb"><Link href="/">채용 테스트</Link> / {test.title}</div>
        <div className="dash-title-row">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1 className="screen-title">{test.title}</h1>
            <p className="screen-subtitle" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span>코드 <span className="code-pill" style={{ color: "#18181B" }}>{test.code}</span></span>
              <span>{formatDateTime(test.startsAt)} ~ {formatDateTime(test.endsAt)}</span>
              <StatusBadge status={testStatus(test)} />
            </p>
          </div>
        </div>
        <div className="card">
          {submissions.length === 0 ? (
            <div className="empty-state">아직 참여한 응시자가 없어요. 코드 <span className="code-pill">{test.code}</span>와 <code>/test</code> 주소를 전달해주세요.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>이름</th><th>생년월일</th><th>전화번호</th><th>직무</th><th>상태</th><th>제출 시각</th><th>답변</th><th></th></tr>
                </thead>
                <tbody>
                  {submissions.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>{s.candidate.name}</td>
                      <td>{s.candidate.birthDate}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatPhone(s.candidate.phone)}</td>
                      <td>{s.roleLabel ?? "-"}</td>
                      <td><StatusBadge status={s.state} /></td>
                      <td style={{ whiteSpace: "nowrap" }}>{s.completedAt ? formatDateTime(s.completedAt) : "-"}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{s.answers ? `${s.answers.filter((a) => a.answer.trim()).length} / ${s.answers.length}` : "-"}</td>
                      <td style={{ textAlign: "right" }}>{s.state === "completed" ? <Link href={`/tests/${test.id}/submissions/${s.id}`} className="table-link">상세</Link> : null}</td>
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
