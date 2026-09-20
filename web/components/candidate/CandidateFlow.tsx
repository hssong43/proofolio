"use client";
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '../Header';
import { VerificationFlow } from '../VerificationFlow';
import { CodeScreen } from './CodeScreen';
import { InfoScreen } from './InfoScreen';
import { RoleConfirmScreen } from './RoleConfirmScreen';
import { CANDIDATE_STEP_LABELS } from '@/lib/data';
import { recruitingRequest } from '@/lib/client';
import type { Candidate, PublicTest, Submission } from '@/lib/types';
type Step='code'|'info'|'confirm'|'flow';
type Entry={test:PublicTest;submission:Submission};
const STEP_INDEX={code:0,info:1,confirm:2,flow:3};

export function CandidateFlow({resumeSubmissionId}:{resumeSubmissionId?:string}) {
  const [step,setStep]=useState<Step>('code'),[code,setCode]=useState('');
  const [test,setTest]=useState<PublicTest|null>(null),[submission,setSubmission]=useState<Submission|null>(null);
  const [error,setError]=useState<string|null>(null),[submitting,setSubmitting]=useState(false);
  const [member,setMember]=useState(false),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let cancelled=false;
    void (async()=>{
      try {
        const auth=await recruitingRequest<{user:unknown}>('/api/auth');
        if(cancelled)return;setMember(!!auth.user);
        if(auth.user&&resumeSubmissionId) {
          const entry=await recruitingRequest<Entry>('/api/candidate/submissions/'+encodeURIComponent(resumeSubmissionId));
          if(cancelled)return;
          setSubmission(entry.submission);setTest(entry.test);setStep(entry.submission.runId?'flow':'confirm');
        }
      }catch(e){if(!cancelled)setError((e as Error).message);}
      finally{if(!cancelled)setLoading(false);}
    })();
    return ()=>{cancelled=true;};
  },[resumeSubmissionId]);
  const onCode=async(value:string)=>{
    setSubmitting(true);setError(null);
    try{setTest(await recruitingRequest<PublicTest>('/api/candidate/code',{code:value}));setCode(value);setStep('info');}
    catch(e){setError((e as Error).message);}finally{setSubmitting(false);}
  };
  const onInfo=async(info:Candidate&{consent:true})=>{
    setSubmitting(true);setError(null);
    try{
      const entry=await recruitingRequest<Entry>('/api/candidate/join',{code,...info});
      setTest(entry.test);setSubmission(entry.submission);setStep(entry.submission.runId?'flow':'confirm');
      history.replaceState(null,'','/test?submission='+entry.submission.id);
    }catch(e){setError((e as Error).message);}finally{setSubmitting(false);}
  };
  const id=submission?.id;
  const linkRun=useCallback(async(runId:string)=>{
    const response=await recruitingRequest<{ok:boolean}>('/api/candidate/submissions/'+id,{runId});
    if(response.ok!==true)throw new Error('실행 연결을 확인하지 못했어요.');
  },[id]);
  const complete=useCallback(async(runId:string)=>{
    const response=await recruitingRequest<{ok:boolean;submissionId:string}>('/api/candidate/submissions/'+id+'/answers',{runId});
    if(response.ok!==true||response.submissionId!==id)throw new Error('제출 확인에 실패했어요.');
  },[id]);

  if(!loading&&member&&step==='flow'&&test&&submission) return <VerificationFlow
    totalSeconds={test.totalSeconds} questionCount={test.questionCount} initialRole={test.role}
    resumeRunId={submission.runId??undefined} submissionId={submission.id}
    headerSteps={CANDIDATE_STEP_LABELS} stepOffset={2} headerRight={<span className="chip">{submission.candidate.name}</span>}
    onRunReady={linkRun} onComplete={complete} onHome={()=>location.assign('/test')}/>;
  return <div style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
    <Header stepIndex={STEP_INDEX[step]} steps={CANDIDATE_STEP_LABELS} right={<Link className="text-button" href="/">내 계정</Link>}/>
    <main className="app-main">
      {loading?<p role="status">계정과 응시 정보를 확인하는 중…</p>:!member?<section className="screen">
        <h1 className="screen-title">로그인하고 테스트에 참여하세요</h1>
        <p className="screen-subtitle">기존 이메일 계정으로 답변을 저장하고 중단한 응시를 이어갈 수 있어요.</p>
        <Link className="btn-primary" href={'/login?next='+encodeURIComponent('/test'+(resumeSubmissionId?'?submission='+resumeSubmissionId:''))}>이메일 로그인</Link>
        <Link className="text-button" href="/?demo=1">로그인 없이 예제 체험</Link>
      </section>:resumeSubmissionId&&error?<div className="error-box" role="alert">{error} <Link href="/test">코드부터 다시 확인</Link></div>:
      submission?.completedAt&&!submission.runId?<section className="screen"><h1 className="screen-title">제출 완료</h1><p>기존 분석은 삭제·만료되어 다시 열 수 없어요.</p></section>:<>
        {step==='code'&&<CodeScreen submitting={submitting} error={error} onSubmit={value=>void onCode(value)}/>}
        {step==='info'&&test&&<InfoScreen test={test} submitting={submitting} error={error} onSubmit={info=>void onInfo(info)}/>}
        {step==='confirm'&&test&&<RoleConfirmScreen role={test.role} roleLabel={test.roleLabel} testTitle={test.title} onConfirm={()=>setStep('flow')}/>}
      </>}
    </main>
  </div>;
}
