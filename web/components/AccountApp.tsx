"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { VerificationFlow, type VerificationFlowProps } from './VerificationFlow';
import type { RunStatus } from '@/lib/types';
import Link from 'next/link';

type Member = { email: string; name: string };
type HistoryRun = { id: string; file_name: string; state: string; started_at: string; generated_question_count: number };
async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했어요.');
  return body;
}
const auth = (body: unknown) => api('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function AccountApp({ resumeRunId, recovery, authError, loginRequested, returnTo, ...flowProps }: VerificationFlowProps & { recovery?: boolean; authError?: boolean; loginRequested?: boolean; returnTo?: string }) {
  const [member, setMember] = useState<Member | null>(null), [loading, setLoading] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false), [mode, setMode] = useState<'signin' | 'signup' | 'reset' | 'password'>(recovery ? 'password' : 'signin');
  const [message, setMessage] = useState(authError ? '인증 링크를 확인하지 못했어요. 다시 로그인해주세요.' : ''), [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryRun[] | null>(null), [runId, setRunId] = useState(resumeRunId);
  const [demo, setDemo] = useState(flowProps.demo ?? false), [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = async () => { const data = await api('/api/auth'); setMember(data.user); if(!data.configured)setMessage('로그인 서버 설정이 필요해요. 예제 체험은 이용할 수 있어요.'); return data.user as Member | null; };
  useEffect(() => { void refresh().catch(() => setMessage('로그인 서버 설정을 확인해주세요. 예제 체험은 이용할 수 있어요.')).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (recovery && !loading) setLoginOpen(true); }, [recovery, loading]);
  useEffect(() => {
    if (loginRequested && !loading) {
      if (member && returnTo) location.replace(returnTo);
      else if (!member) setLoginOpen(true);
    }
  }, [loginRequested, loading, member, returnTo]);
  useEffect(() => { if (loginOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [loginOpen]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const data = await auth({ action: mode, email: form.get('email'), password: form.get('password') });
      setMessage(data.message || '완료했어요.');
      if (mode === 'signin' || mode === 'signup' || mode === 'password') {
        const user = await refresh();
        if (user) {
          if (returnTo) { location.assign(returnTo); return; }
          setLoginOpen(false); setDemo(false); setRevision(n => n + 1);
        }
      }
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };
  const showHistory = async () => {
    try { setHistory((await api('/api/runs')).runs); } catch (e) { setMessage((e as Error).message); }
  };
  const download = async (id: string) => {
    try {
      const run: RunStatus = await api(`/api/analyze/${id}`);
      const text = run.result?.questions.map((q, i) => `${i + 1}. ${q.prompt}\n${q.quotes.join('\n')}\n답변: ${run.answers?.find(a => a.questionId === q.id)?.answer || '(미답변)'}`).join('\n\n') || '';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'proofolio-questions-and-answers.txt'; link.click(); URL.revokeObjectURL(url);
    } catch (e) { setMessage((e as Error).message); }
  };
  return <>
    <div className="account-bar">
      <span>{loading ? '계정 확인 중' : member ? member.email : '로그인 없이 예제를 체험해보세요'}</span>
      <div>
        <Link className="text-button" href="/dashboard">채용 대시보드</Link>
        <Link className="text-button" href="/test">코드로 응시</Link>
        <button className="text-button" onClick={() => { window.history.replaceState(null,'','/?demo=1'); setDemo(true); setRunId(undefined); setHistory(null); setRevision(n => n + 1); }}>예제 체험</button>
        {member ? <>
          <button className="text-button" onClick={() => { window.history.replaceState(null,'','/'); setDemo(false); setRunId(undefined); setHistory(null); setRevision(n => n + 1); }}>새 분석</button>
          <button className="text-button" onClick={() => void showHistory()}>내 기록</button>
          <button className="text-button" onClick={() => void auth({ action: 'logout' }).then(() => {
            Object.keys(localStorage).filter(k => k.startsWith('proofolio:draft:')).forEach(k => localStorage.removeItem(k)); location.assign('/');
          }).catch(e => setMessage(e.message))}>로그아웃</button>
        </> : <button className="text-button" onClick={() => { setMode('signin'); setMessage(''); setLoginOpen(true); }}>이메일 로그인</button>}
      </div>
    </div>
    {message && !loginOpen && <p className="account-message" role="status">{message}</p>}
    {!loading && (history ? <main className="app-main"><section className="screen">
      <h1 className="screen-title">내 기록</h1>
      <p className="screen-subtitle">원문과 답변은 비공개로 30일 보관해요. 삭제한 기록은 7일 후 정리돼요.</p>
      {!history.length && <p>저장된 분석이 아직 없어요.</p>}
      {history.map(run => <article className="card history-card" key={run.id}>
        <div><h2>{run.file_name}</h2><p>{new Date(run.started_at).toLocaleDateString('ko-KR')} · 질문 {run.generated_question_count}개 · {run.state}</p></div>
        <div className="history-actions">
          <button className="btn-primary" onClick={() => { setRunId(run.id); setDemo(false); setHistory(null); setRevision(n => n + 1); }}>열기 / 이어서 답변</button>
          {run.state === 'complete' && <button className="btn-secondary" onClick={() => void download(run.id)}>질문·답변 내려받기</button>}
          {!['running', 'queued'].includes(run.state) && <button className="text-button" onClick={() => {
            if (!confirm('이 기록을 목록에서 삭제할까요? 7일 뒤 원문과 답변이 정리됩니다.')) return;
            void api(`/api/analyze/${run.id}`, { method: 'DELETE' }).then(() => showHistory()).catch(e => setMessage(e.message));
          }}>삭제</button>}
        </div>
      </article>)}
    </section></main> : <VerificationFlow key={`${revision}:${member?.email || 'guest'}`} {...flowProps}
      demo={!member || demo} resumeRunId={member ? runId : undefined} />)}
    <dialog ref={dialog} className="account-dialog" onCancel={() => setLoginOpen(false)} onClose={() => setLoginOpen(false)}>
      <form onSubmit={submit}>
        <div className="dialog-heading"><h2>{mode === 'signup' ? '이메일로 시작하기' : mode === 'reset' ? '비밀번호 찾기' : mode === 'password' ? '새 비밀번호' : '다시 만나서 반가워요'}</h2>
          <button type="button" className="text-button" onClick={() => setLoginOpen(false)} aria-label="닫기">닫기</button></div>
        <p>계정에 분석 기록과 질문·답변을 안전하게 보관해요.</p>
        {mode !== 'password' && <label>이메일<input className="text-input" name="email" type="email" autoComplete="email" required maxLength={254} /></label>}
        {mode !== 'reset' && <label>비밀번호<input className="text-input" name="password" type="password" minLength={8} maxLength={128} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required /></label>}
        {message && <p role="status">{message}</p>}
        <button className="btn-primary" disabled={busy}>{busy ? '처리 중…' : mode === 'signup' ? '가입하고 인증 메일 받기' : mode === 'reset' ? '재설정 메일 받기' : mode === 'password' ? '비밀번호 변경' : '로그인'}</button>
        <div className="history-actions">
          <button type="button" className="text-button" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setMessage(''); }}>{mode === 'signup' ? '기존 계정으로 로그인' : '계정 만들기'}</button>
          <button type="button" className="text-button" onClick={() => { setMode('reset'); setMessage(''); }}>비밀번호 찾기</button>
        </div>
      </form>
    </dialog>
  </>;
}
