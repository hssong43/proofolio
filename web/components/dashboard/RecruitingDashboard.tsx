"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '../Header';
import { Stat } from '../Stat';
import { CreateTestForm } from './CreateTestForm';
import { StatusBadge } from './StatusBadge';
import { recruitingRequest } from '@/lib/client';
import { ROLES } from '@/lib/data';
import { formatDateTime } from '@/lib/period';
import { formatPhone } from '@/lib/candidate';
import type { Submission, SubmissionDetail, TestSummary } from '@/lib/types';

type Listing={test:TestSummary;submissions:Submission[]};
export function RecruitingDashboard({testId,submissionId}:{testId?:string;submissionId?:string}) {
  const [tests,setTests]=useState<TestSummary[]>([]),[listing,setListing]=useState<Listing|null>(null);
  const [detail,setDetail]=useState<SubmissionDetail|null>(null),[error,setError]=useState('');
  const [loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [deleting,setDeleting]=useState(false);
  const path=testId?'/tests/'+testId+(submissionId?'/submissions/'+submissionId:''):'/dashboard';
  useEffect(()=>{
    let cancelled=false;if(revision===0)setLoading(true);setError('');
    const request=submissionId&&testId
      ? recruitingRequest<SubmissionDetail>('/api/admin/tests/'+testId+'/submissions/'+submissionId).then(r=>{if(!cancelled)setDetail(r);})
      : testId
        ? recruitingRequest<Listing>('/api/admin/tests/'+testId).then(r=>{if(!cancelled)setListing(r);})
        : recruitingRequest<{tests:TestSummary[]}>('/api/admin/tests').then(r=>{if(!cancelled)setTests(r.tests);});
    void request.catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[testId,submissionId,revision]);
  const roleLabel=(id:string)=>ROLES.find(r=>r.id===id)?.label??id;
  const refresh=()=>setRevision(n=>n+1);
  const remove=async()=>{
    if(!testId||!confirm('이 테스트와 응시자 정보를 삭제할까요? 응시자 본인의 분석·답변 기록은 유지돼요.'))return;
    setDeleting(true);
    try {await recruitingRequest('/api/admin/tests/'+testId,undefined,'DELETE');location.assign('/dashboard');}
    catch(e){setError((e as Error).message);setDeleting(false);}
  };
  return <div style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
    <Header stepIndex={-1} steps={[]} right={<Link className="text-button" href="/">내 계정 / 분석</Link>}/>
    <main className="dash-main">
      <nav className="breadcrumb" aria-label="채용 메뉴"><Link href="/dashboard">채용 대시보드</Link>
        {testId&&<> / <Link href={'/tests/'+testId}>응시 현황</Link></>}
        {' · '}<Link href="/test">코드로 응시</Link></nav>
      <div className="dash-title-row"><div><h1 className="screen-title">{submissionId?'응시 결과':testId?'응시 현황':'채용 테스트'}</h1>
        <p className="screen-subtitle">내가 만든 테스트와 동의한 응시자의 질문·답변만 확인할 수 있어요.</p></div>
        <button className="btn-secondary" onClick={refresh} disabled={loading}>새로고침</button></div>
      <p className="notice-box">응시 정보는 30일 보관하며, 원본 PDF·코드는 공유하지 않아요.</p>
      {loading?<p role="status">불러오는 중…</p>:error?<div className="error-box" role="alert">{error}{' '}
        <Link href={'/login?next='+encodeURIComponent(path)}>이메일 로그인</Link></div>:submissionId&&detail?<>
        <section className="card" style={{padding:24}}>
          <h2>{detail.submission.candidate.name} · {detail.test.title}</h2>
          <p>{detail.submission.candidate.birthDate} · {formatPhone(detail.submission.candidate.phone)}</p>
          <StatusBadge status={detail.submission.state}/>
          <p>{detail.submission.completedAt?'제출 '+formatDateTime(detail.submission.completedAt):'아직 제출을 완료하지 않았어요.'}</p>
        </section>
        {detail.run?.result?<section className="card">
          {detail.run.result.questions.map((q,i)=>{
            const a=detail.run!.answers?.find(a=>a.questionId===q.id);
            return <article className="qa-item" key={q.id}><h2 className="qa-prompt">{i+1}. {q.prompt}</h2>
              <div className="qa-meta">{q.projectTitle}{q.pages.length?' · '+q.pages.join(', ')+'페이지':''}</div>
              <div className="qa-answer" data-empty={!a?.answer}>{a?.answer||'(미답변)'}</div>
              <div className="qa-meta">{a?'답변 시간 '+a.seconds+'초':'저장된 답변 없음'}</div>
              <details><summary>질문 의도와 확인 사항</summary><p>{q.intent}</p><ul>{q.listenFor.map((v,j)=><li key={j}>{v}</li>)}</ul></details>
            </article>;
          })}
        </section>:<p className="empty-state">{detail.run?'분석이 아직 완료되지 않았어요.':'연결된 분석이 없거나 삭제·만료되어 표시할 수 없어요.'}</p>}
      </>:testId&&listing?<>
        <section className="card" style={{padding:24}}><h2>{listing.test.title}</h2>
          <p>{roleLabel(listing.test.role)} · 목표 {listing.test.questionCount}문항 · 코드 <span className="code-pill">{listing.test.code}</span></p>
          <p>{formatDateTime(listing.test.startsAt)} ~ {formatDateTime(listing.test.endsAt)}</p>
          <StatusBadge status={listing.test.status}/>
        </section>
        <div className="card form-grid" style={{padding:8}}><Stat label="응시자" value={String(listing.test.submissionCount)}/>
          <Stat label="제출 완료" value={String(listing.test.completedCount)}/></div>
        <div className="card table-wrap">{listing.submissions.length?<table className="table">
          <thead><tr><th>이름</th><th>생년월일</th><th>연락처</th><th>상태</th><th>참여 시각</th><th>결과</th></tr></thead>
          <tbody>{listing.submissions.map(s=><tr key={s.id}><td>{s.candidate.name}</td><td>{s.candidate.birthDate}</td>
            <td>{formatPhone(s.candidate.phone)}</td><td><StatusBadge status={s.state}/></td><td>{formatDateTime(s.joinedAt)}</td>
            <td><Link className="table-link" href={'/tests/'+testId+'/submissions/'+s.id}>질문·답변 보기</Link></td></tr>)}</tbody>
        </table>:<p className="empty-state">아직 응시자가 없어요.</p>}</div>
        <p className="field-hint">최근 응시자 최대 500명 표시</p>
        <button className="text-button" disabled={deleting} onClick={()=>void remove()}>테스트와 응시 정보 삭제</button>
      </>:<>
        <CreateTestForm onCreated={refresh}/>
        <div className="card table-wrap">{tests.length?<table className="table">
          <thead><tr><th>제목</th><th>직무</th><th>코드</th><th>기간</th><th>상태</th><th>제출</th><th>결과</th></tr></thead>
          <tbody>{tests.map(t=><tr key={t.id}><td>{t.title}</td><td>{roleLabel(t.role)}</td><td className="code-pill">{t.code}</td>
            <td>{formatDateTime(t.startsAt)} ~ {formatDateTime(t.endsAt)}</td><td><StatusBadge status={t.status}/></td>
            <td>{t.completedCount} / {t.submissionCount}</td><td><Link className="table-link" href={'/tests/'+t.id}>보기</Link></td></tr>)}</tbody>
        </table>:<p className="empty-state">아직 연 테스트가 없어요. 위에서 첫 테스트를 열어보세요.</p>}</div>
        <p className="field-hint">최근 테스트 최대 100개 표시</p>
      </>}
    </main>
  </div>;
}
