import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { AccountMenu } from "@/components/dashboard/AccountMenu";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Stat } from "@/components/Stat";
import { requireAdmin } from "@/lib/server/session";
import { getSubmission, getTest } from "@/lib/server/store";
import { formatDateTime } from "@/lib/period";
import { formatPhone } from "@/lib/candidate";
import { formatElapsed, ROLES } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SubmissionDetailPage({ params }: { params: Promise<{ testId: string; submissionId: string }> }) {
  const account = await requireAdmin();
  const { testId, submissionId } = await params;
  const test = await getTest(testId).catch(() => null);
  const submission = test ? await getSubmission(test.id, submissionId).catch(() => null) : null;
  if (!test || !submission) notFound();
  const questions = submission.questions ?? [];
  const answers = new Map((submission.answers ?? []).map((a) => [a.questionId, a]));
  const evaluations = new Map((submission.evaluation?.items ?? []).map((i) => [i.questionId, i]));
  const answered = (submission.answers ?? []).filter((a) => a.answer.trim()).length;
  const evaluation = submission.evaluation;
  const roleLabel = ROLES.find((r) => r.id === test.role)?.label ?? submission.roleLabel ?? "-";
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header stepIndex={-1} steps={[]} right={<AccountMenu name={account.name} company={account.company} />} />
      <main className="dash-main">
        <div className="breadcrumb"><Link href="/">채용 테스트</Link> / <Link href={`/tests/${test.id}`}>{test.title}</Link> / {submission.candidate.name}</div>
        <div className="dash-title-row">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1 className="screen-title">{submission.candidate.name}</h1>
            <p className="screen-subtitle">
              {submission.candidate.birthDate} · {formatPhone(submission.candidate.phone)} · {submission.completedAt ? `${formatDateTime(submission.completedAt)} 제출` : "미제출"}
            </p>
          </div>
          {evaluation && (
            <div className="result-panel" data-passed={evaluation.passed}>
              <span className="result-score">{evaluation.overallScore}<span className="result-unit">점</span></span>
              <StatusBadge status={evaluation.passed ? "passed" : "failed"} />
              <span className="field-hint">통과 기준 {evaluation.passScore}점 · AI 평가(mock)</span>
            </div>
          )}
        </div>
        <div className="card stat-grid">
          <Stat label="직무" value={roleLabel} />
          <Stat label="답변한 질문 수" value={`${answered} / ${questions.length}`} bordered />
          <Stat label="총 소요 시간" value={formatElapsed(submission.elapsedSeconds ?? 0)} />
        </div>
        <div className="card">
          {questions.length === 0 ? (
            <div className="empty-state">저장된 질문이 없어요.</div>
          ) : (
            questions.map((q, i) => {
              const a = answers.get(q.id);
              const ev = evaluations.get(q.id);
              const text = a?.answer.trim() ?? "";
              return (
                <div key={q.id || i} className="qa-item">
                  <div className="qa-meta"><span style={{ fontWeight: 600, color: "#18181B" }}>Q{i + 1}</span><span>{q.source}</span></div>
                  {q.quotes.map((quote, j) => <blockquote key={j} className="quote-box" style={{ margin: 0 }}>{quote}</blockquote>)}
                  {q.notes.map((note, j) => <p key={j} style={{ margin: 0, fontSize: 13, color: "#71717A" }}>{note}</p>)}
                  <p className="qa-prompt">{q.prompt}</p>
                  <div className="qa-answer" data-empty={!text}>{text || "답변 없음"}</div>
                  <div className="qa-meta"><span>{a ? `${a.seconds}초 사용` : "기록 없음"}</span><span>{text.length} / 500자</span></div>
                  {ev && (
                    <div className="qa-eval">
                      <span className="score-pill" data-level={ev.score >= 70 ? "high" : ev.score >= 40 ? "mid" : "low"}>{ev.score}점</span>
                      <span className="qa-eval-comment">{ev.comment}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </main>
    </div>
  );
}
