"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '../Header';
import { Stat } from '../Stat';
import { fetchExample } from '@/lib/client';
import type { Track } from '@/lib/types';

const tracks = [{ track: 'design', label: '디자인' }, { track: 'marketing', label: '마케팅' }, { track: 'coding', label: '코딩' }] as const;
type Entry = Awaited<ReturnType<typeof fetchExample>> & { track: Track; label: string };

// The public dashboard reads only the curated example API, never users, runs or answers.
export function DemoDashboard() {
  const [entries, setEntries] = useState<Entry[]>([]), [selected, setSelected] = useState<Track | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void Promise.all(tracks.map(async track => ({ ...await fetchExample(track.track), ...track })))
      .then(items => { if (!cancelled) setEntries(items); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision]);
  const item = entries.find(entry => entry.track === selected);
  return <div style={{ minHeight: '100vh' }}>
    <Header stepIndex={-1} steps={[]} right={<Link className="text-button" href="/?demo=1">예제 체험하기</Link>} />
    <main className="dash-main">
      <div className="dash-title-row">
        <div><h1 className="screen-title">관리자 데모</h1><p className="screen-subtitle">저장된 예제와 생성 질문을 로그인 없이 살펴보세요.</p></div>
        <button className="btn-secondary" disabled={loading} onClick={() => setRevision(n => n + 1)}>새로고침</button>
      </div>
      <p className="notice-box">공개 예제 전용 · 읽기 전용 화면이에요. 실제 방문자·제출 파일·답변은 공개하지 않으며, 수정·삭제·새 AI 분석은 실행하지 않아요.</p>
      {loading ? <p role="status">예제를 불러오는 중…</p> : error ? <p className="error-box" role="alert">{error} 새로고침으로 다시 시도해주세요.</p> : <>
        <div className="card stat-grid">
          <Stat label="예제" value={`${entries.length}개`} />
          <Stat label="생성 질문" value={`${entries.reduce((n, entry) => n + entry.result.questions.length, 0)}개`} bordered />
          <Stat label="실제 방문자 데이터" value="비공개" />
        </div>
        <section className="stat-grid" aria-label="예제 목록">
          {entries.map(entry => <article className="card history-card" key={entry.track}>
            <span className="qa-meta">{entry.label}</span><h2>{entry.title}</h2>
            <p>질문 {entry.result.questions.length}개 · {entry.result.status === 'evidence_ready' ? '생성 완료' : '검토 권장'}</p>
            <button className="btn-secondary" aria-label={`${entry.label} 예제 질문 보기`} aria-pressed={selected === entry.track} onClick={() => setSelected(entry.track)}>질문 보기</button>
          </article>)}
        </section>
        {item && <section key={item.track} aria-label={`${item.label} 예제 상세`}>
          <h2>{item.title} · {item.result.questions.length}개 질문</h2>
          <p className="notice-box">{item.notice}</p>
          <p className="screen-subtitle">예제 답변은 저장하지 않아요. 이미지·전체 PDF는 공개 사용 허락 확인 전까지 비공개로 보관해요.</p>
          <div className="card">{item.result.questions.map((q, i) => <article className="qa-item" key={q.id}>
            <h3 className="qa-prompt">{i + 1}. {q.prompt}</h3>
            <p className="qa-meta">{q.projectTitle}{q.pages.length ? ` · ${q.pages.join(', ')}페이지` : ' · 코드 원문 근거'}</p>
            {q.quotes.map((quote, j) => <blockquote className="quote-box" style={{ margin: '12px 0' }} key={j}>{quote}</blockquote>)}
            {q.notes.map((note, j) => <p key={j}>{note}</p>)}
            <details><summary>질문 의도와 확인 사항</summary><p>{q.intent}</p><ul>{q.listenFor.map((text, j) => <li key={j}>{text}</li>)}</ul></details>
          </article>)}</div>
        </section>}
      </>}
    </main>
  </div>;
}
