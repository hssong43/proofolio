"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Header } from '../Header';
import { Stat } from '../Stat';
import { PortfolioImages } from '../PortfolioImages';
import { fetchExample } from '@/lib/client';
import type { Track } from '@/lib/types';

const tracks = [
  { track: 'design', label: '디자이너', candidate: '응시자 1' },
  { track: 'marketing', label: '마케터', candidate: '응시자 2' },
  { track: 'coding', label: '개발자', candidate: '응시자 3' },
] as const;
type Entry = Awaited<ReturnType<typeof fetchExample>> & { track: Track; label: string; candidate: string };
type Selection = { track: Track; view: 'portfolio' | 'answers' };

// Candidate identities and answers are samples. Never read real visitors or submissions here.
export function DemoDashboard() {
  const [entries, setEntries] = useState<Entry[]>([]), [selected, setSelected] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void Promise.all(tracks.map(async track => ({ ...await fetchExample(track.track), ...track })))
      .then(items => { if (!cancelled) setEntries(items); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision]);
  useEffect(() => {
    if (selected) { detailRef.current?.focus({ preventScroll: true }); detailRef.current?.scrollIntoView({ block: 'start' }); }
  }, [selected]);
  const item = entries.find(entry => entry.track === selected?.track);
  return <div style={{ minHeight: '100vh' }}>
    <Header stepIndex={-1} steps={[]} right={<Link className="text-button" href="/?demo=1">응시 화면으로</Link>} />
    <main className="dash-main">
      <div className="dash-title-row">
        <div><h1 className="screen-title">응시자 관리</h1><p className="screen-subtitle">응시자별 포트폴리오와 질문·답변을 확인하세요.</p></div>
        <button className="btn-secondary" disabled={loading} onClick={() => setRevision(n => n + 1)}>새로고침</button>
      </div>
      <p className="screen-subtitle">예시 데이터 · 응시자와 답변은 체험용이며, 실제 방문자의 정보는 공개하지 않아요.</p>
      {loading ? <p role="status">응시 목록을 불러오는 중…</p> : error ? <p className="error-box" role="alert">{error} 새로고침으로 다시 시도해주세요.</p> : <>
        <div className="card stat-grid">
          <Stat label="응시자" value={`${entries.length}명`} />
          <Stat label="생성 질문" value={`${entries.reduce((n, entry) => n + entry.result.questions.length, 0)}개`} bordered />
          <Stat label="예시 답변" value={`${entries.reduce((n, entry) => n + (entry.sampleAnswers?.length ?? 0), 0)}개`} />
        </div>
        <section className="card table-wrap" aria-label="응시자 목록">
          <table className="table applicant-table">
            <thead><tr><th scope="col">응시자</th><th scope="col">직무</th><th scope="col">상태</th><th scope="col">답변 / 질문</th><th scope="col">포트폴리오</th><th scope="col">질문·답변</th></tr></thead>
            <tbody>{entries.map(entry => <tr key={entry.track} data-selected={selected?.track === entry.track}>
              <td><strong>{entry.candidate}</strong><div className="qa-meta">{entry.title}</div></td>
              <td data-label="직무">{entry.label}</td>
              <td data-label="상태"><span className="badge" data-status={entry.sampleAnswers?.length === entry.result.questions.length ? 'completed' : 'joined'}>
                {entry.sampleAnswers?.length === entry.result.questions.length ? '답변 완료' : '답변 대기'}</span></td>
              <td data-label="답변 / 질문">{entry.sampleAnswers?.length ?? 0} / {entry.result.questions.length}</td>
              <td><button className="btn-secondary" aria-label={`${entry.candidate} 포트폴리오 보기`} onClick={() => setSelected({ track: entry.track, view: 'portfolio' })}>포트폴리오 보기</button></td>
              <td><button className="btn-primary" aria-label={`${entry.candidate} 질문·답변 보기`} onClick={() => setSelected({ track: entry.track, view: 'answers' })}>질문·답변 보기</button></td>
            </tr>)}</tbody>
          </table>
        </section>
        {item && <section key={item.track} ref={detailRef} tabIndex={-1} className="applicant-detail" aria-label={`${item.candidate} 상세`}>
          <div className="dash-title-row"><div><h2>{item.candidate}</h2><p className="screen-subtitle">{item.label} · {item.title}</p></div>
            <button className="text-button" onClick={() => setSelected(null)}>상세 닫기</button></div>
          <div className="history-actions" aria-label="상세 보기 선택">
            <button className={selected?.view === 'portfolio' ? 'btn-primary' : 'btn-secondary'} aria-pressed={selected?.view === 'portfolio'} onClick={() => setSelected({ track: item.track, view: 'portfolio' })}>포트폴리오 보기</button>
            <button className={selected?.view === 'answers' ? 'btn-primary' : 'btn-secondary'} aria-pressed={selected?.view === 'answers'} onClick={() => setSelected({ track: item.track, view: 'answers' })}>질문·답변 보기</button>
          </div>
          {selected?.view === 'portfolio' ? <div className="portfolio-pages">
            {item.track === 'coding' ? <>
              <a className="text-button" href="https://github.com/hssong43/proofolio" target="_blank" rel="noopener noreferrer">GitHub 포트폴리오 열기</a>
              {item.result.questions.map((q, i) => <details className="source-preview" key={q.id} open={i === 0}>
                <summary>{q.projectTitle} · 질문 {i + 1} 연결 코드</summary><pre>{q.quotes.join('\n\n')}</pre>
              </details>)}
            </> : item.portfolioUrl ? <PortfolioDocument key={`${revision}:${item.track}`} url={item.portfolioUrl} candidate={item.candidate} pageCount={item.result.pageCount} /> :
              <p className="empty-state">등록된 원본 포트폴리오가 없어요.</p>}
          </div> : <>
            <p className="screen-subtitle">예시 답변은 화면 체험용으로 작성했으며 실제 포트폴리오 작성자의 답변이 아니에요.</p>
            <div className="card">{item.result.questions.map((q, i) => {
              const answer = item.sampleAnswers?.find(a => a.questionId === q.id)?.answer;
              return <article className="qa-item" key={q.id}>
                {q.pages.length > 0 && <PortfolioImages key={revision} images={(item.images ?? []).filter(image => q.pages.includes(image.page))} label={item.candidate} thumbnails />}
                <h3 className="qa-prompt">{i + 1}. {q.prompt}</h3>
                <p className="qa-meta">{q.projectTitle}{q.pages.length ? ` · ${q.pages.join(', ')}페이지` : ''}</p>
                <div><p className="qa-meta">예시 답변</p><div className="qa-answer" data-empty={!answer}>{answer ?? '이 질문의 예시 답변은 아직 등록되지 않았어요.'}</div></div>
                <details><summary>질문 의도와 확인 사항</summary><p>{q.intent}</p><ul>{q.listenFor.map((text, j) => <li key={j}>{text}</li>)}</ul></details>
              </article>;
            })}</div>
          </>}
        </section>}
      </>}
    </main>
  </div>;
}

function PortfolioDocument({ url, candidate, pageCount }: { url: string; candidate: string; pageCount: number }) {
  const [attempt, setAttempt] = useState(0);
  const source = `${url}?retry=${attempt}`;
  return <div className="portfolio-pages">
    <div className="dash-title-row">
      <p className="screen-subtitle">전체 포트폴리오 · {pageCount}페이지</p>
      <div className="history-actions">
        <a className="text-button" href={source} target="_blank" rel="noopener noreferrer">전체 PDF 새 탭으로 열기</a>
        <button className="text-button" onClick={() => setAttempt(n => n + 1)}>PDF 다시 불러오기</button>
      </div>
    </div>
    <object key={attempt} className="portfolio-document card" data={`${source}#view=FitH`} type="application/pdf" aria-label={`${candidate} 전체 포트폴리오`}>
      <p className="empty-state">미리보기가 표시되지 않으면 새 탭으로 열어주세요. <a href={source} target="_blank" rel="noopener noreferrer">전체 PDF 열기</a></p>
    </object>
  </div>;
}
