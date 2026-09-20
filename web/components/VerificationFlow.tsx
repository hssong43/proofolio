"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_QUESTION_COUNT, ROLES, formatElapsed, formatFileSize, type RoleId, type UiQuestion } from '@/lib/data';
import { fetchExample, fetchStatus, startAnalysis, startCodeAnalysis, submitAnswer } from '@/lib/client';
import type { AnswerRecord, ClientResult } from '@/lib/types';
import { Header } from './Header';
import { RoleScreen } from './screens/RoleScreen';
import { UploadScreen, type UploadedFile, type UploadTab } from './screens/UploadScreen';
import { AnalyzingScreen } from './screens/AnalyzingScreen';
import { ReadyScreen } from './screens/ReadyScreen';
import { QuestionScreen } from './screens/QuestionScreen';
import { CompleteScreen } from './screens/CompleteScreen';

export type VerificationFlowProps = { totalSeconds?: number; questionCount?: number; demo?: boolean; fastAnalysis?: boolean; resumeRunId?: string };
export type Screen = 'role' | 'upload' | 'analyzing' | 'ready' | 'question' | 'complete';
const steps: Record<Screen, number> = {role:0, upload:1, analyzing:2, ready:3, question:4, complete:5};
type State = {
  screen: Screen; role: RoleId | null; tab: UploadTab; file: UploadedFile | null; link: string;
  runId: string | null; stage: number; result: ClientResult | null; error: string | null; submitting: boolean;
  questionIndex: number; answer: string; answers: AnswerRecord[]; secondsLeft: number;
  questionStartedAt: number; startedAt: number; endedAt: number;
  saveState: 'idle' | 'saving' | 'saved' | 'failed'; storageError?: string;
};
const initial = (seconds: number): State => ({screen:'role',role:null,tab:'pdf',file:null,link:'',runId:null,stage:0,result:null,error:null,submitting:false,
  questionIndex:0,answer:'',answers:[],secondsLeft:seconds,questionStartedAt:0,startedAt:0,endedAt:0,saveState:'idle'});
const draftKey = (id: string) => `proofolio:draft:v1:${id}`;
function runUrl(id?: string) { const url = new URL(location.href); if(id) url.searchParams.set('run',id); else url.searchParams.delete('run'); history.replaceState(null,'',url); }

export function VerificationFlow({totalSeconds=40,questionCount=DEFAULT_QUESTION_COUNT,demo=false,resumeRunId}: VerificationFlowProps) {
  const [s,set] = useState(() => initial(totalSeconds));
  const ref = useRef(s); ref.current=s;
  const busy = useRef(false), pending = useRef<AnswerRecord | null>(null);
  const lastSubmitted = useRef<string | null>(null);
  const update = useCallback((patch: Partial<State>) => set(s => ({...s,...patch})),[]);
  const role = ROLES.find(r=>r.id===s.role), total=s.result?.questions.length ?? 0;
  const questions: UiQuestion[] = s.result?.questions.map(q=>({id:q.id,prompt:q.prompt,quotes:q.quotes,notes:q.notes,anchors:q.anchors,
    source:`${q.projectTitle}${q.pages.length ? ` · ${q.pages.join(', ')}페이지 근거` : ' · 코드 원문 근거'}`})) ?? [];
  const summary = {chipsLabel:'분석한 프로젝트',chips:s.result?.projects.map(p=>p.title) ?? [],
    cards:s.result?.projects.map(p=>({label:'프로젝트',name:p.title,desc:p.pages.length ? `${p.pages.length}페이지 · 전체 ${s.result!.pageCount}페이지 중` : '코드 구조 기반 · 실행 검수 없음'})) ?? []};
  const canAnalyze = role?.track === 'coding' ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(s.link.trim()) : !!s.file?.file && s.tab==='pdf';

  const loadResult = useCallback((result: ClientResult, answers: AnswerRecord[]=[], storageError?: string) => {
    const current=ref.current;
    if (!result.questions.length) { update({error:'생성된 질문이 없어요. 이 결과로는 시작할 수 없어요.',stage:3}); return; }
    const questionIndex=result.questions.findIndex(q=>!answers.some(a=>a.questionId===q.id));
    let answer='', remaining=totalSeconds;
    pending.current=null;
    if (current.runId && questionIndex>=0) {
      try {
        const draft=JSON.parse(localStorage.getItem(draftKey(current.runId)) || 'null');
        if (draft?.expires>Date.now() && draft.questionId===result.questions[questionIndex].id && typeof draft.answer==='string') {
          answer=draft.answer.slice(0,500);
          remaining=Number.isInteger(draft.secondsLeft) ? Math.max(0,Math.min(totalSeconds,draft.secondsLeft)) : totalSeconds;
          if(draft.pending?.questionId===draft.questionId && draft.pending.answer===answer && Number.isSafeInteger(draft.pending.seconds) && draft.pending.seconds>=0)
            pending.current=draft.pending;
        } else localStorage.removeItem(draftKey(current.runId));
      } catch { /* Draft storage is best-effort; confirmed server answers remain canonical. */ }
    }
    update({result,answers,stage:3,storageError,questionIndex:Math.max(0,questionIndex),answer,secondsLeft:remaining,
      screen:questionIndex<0?'complete':answers.length || answer || pending.current?'question':'ready',
      startedAt:Date.now(),questionStartedAt:Date.now()-(totalSeconds-remaining)*1000,endedAt:questionIndex<0?Date.now():0,
      saveState:pending.current?'failed':questionIndex<0&&!demo?'saved':'idle',error:pending.current?'저장 확인이 끝나지 않은 답변이에요. 같은 답변으로 재시도해주세요.':null});
  },[demo,totalSeconds,update]);

  useEffect(()=>{
    window.scrollTo({top:0,behavior:'instant'});
  },[s.screen,s.questionIndex]);
  useEffect(()=>{
    if(resumeRunId&&!demo) { runUrl(resumeRunId); update({screen:'analyzing',runId:resumeRunId}); }
  },[resumeRunId,demo,update]);
  useEffect(()=>{
    if(s.screen!=='analyzing'||!s.runId||demo||s.error)return;
    let cancelled=false, timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const status=await fetchStatus(s.runId!); if(cancelled)return;
        update({role:ROLES.find(r=>r.track===status.track)?.id ?? null});
        if(status.state==='failed'){update({error:status.error||'분석이 완료되지 않았어요.'});return;}
        if(status.state==='complete'&&status.result){loadResult(status.result,status.answers,status.storageError);return;}
        update({stage:status.stage});timer=setTimeout(poll,2000);
      }catch(e){if(!cancelled)update({error:(e as Error).message});}
    };
    void poll();return()=>{cancelled=true;clearTimeout(timer);};
  },[s.screen,s.runId,s.error,demo,loadResult,update]);

  // Drafts expire after one day. Pending payloads stay identical across retry/reload.
  useEffect(()=>{
    if(!s.runId||s.screen!=='question')return;
    try { localStorage.setItem(draftKey(s.runId),JSON.stringify({expires:Date.now()+86400000,
      questionId:s.result?.questions[s.questionIndex]?.id,answer:s.answer,secondsLeft:s.secondsLeft,pending:pending.current})); } catch { /* Storage may be disabled. */ }
  },[s.runId,s.screen,s.questionIndex,s.answer,s.secondsLeft,s.saveState,s.result]);

  const submit=useCallback(async()=>{
    const current=ref.current,q=current.result?.questions[current.questionIndex];
    if(busy.current||current.screen!=='question'||!q||lastSubmitted.current===q.id)return;
    busy.current=true;
    const record=pending.current ?? {questionId:q.id,answer:current.answer,seconds:Math.max(0,Math.round((Date.now()-current.questionStartedAt)/1000))};
    pending.current=record;update({saveState:demo?'idle':'saving',error:null});
    try {
      const answers=demo?[...current.answers,record]:await submitAnswer(current.runId!,record);
      const next=current.result!.questions.findIndex(q=>!answers.some(a=>a.questionId===q.id));
      pending.current=null;
      lastSubmitted.current=q.id;
      if(current.runId) { try {localStorage.removeItem(draftKey(current.runId));} catch {} }
      update({answers,answer:'',questionIndex:next<0?current.questionIndex:next,screen:next<0?'complete':'question',
        secondsLeft:totalSeconds,questionStartedAt:Date.now(),endedAt:next<0?Date.now():0,saveState:demo?'idle':'saved'});
    }catch(e){update({saveState:'failed',error:(e as Error).message});}
    finally{busy.current=false;}
  },[demo,totalSeconds,update]);
  useEffect(()=>{
    if(s.screen!=='question'||s.saveState==='saving'||s.saveState==='failed')return;
    const timer=setInterval(()=>{if(ref.current.secondsLeft<=1)void submit();else set(s=>({...s,secondsLeft:s.secondsLeft-1}));},1000);
    return()=>clearInterval(timer);
  },[s.screen,s.questionIndex,s.saveState,submit]);

  const start=async()=>{
    if(busy.current||!role?.track)return;
    busy.current=true;update({submitting:true,error:null});
    try {
      if(demo){
        update({screen:'analyzing'});
        const item=await fetchExample(role.track);
        loadResult({...item.result,exampleNotice:item.notice});
      }else{
        const run=role.track==='coding'?await startCodeAnalysis(s.link.trim(),questionCount):await startAnalysis(s.file!.file!,role.track,questionCount);
        runUrl(run.runId);update({screen:'analyzing',runId:run.runId,stage:0,result:null});
      }
    }catch(e){update({error:(e as Error).message});}finally{busy.current=false;update({submitting:false});}
  };
  const home=()=>{pending.current=null;lastSubmitted.current=null;runUrl();set(initial(totalSeconds));};
  return <div style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
    <Header stepIndex={steps[s.screen]}/>
    <main className="app-main">
      {s.screen==='role'&&<RoleScreen role={s.role} demo={demo} onSelect={role=>update({role,tab:role==='dev'?'link':'pdf'})}
        onNext={()=>demo?void start():update({screen:'upload',error:null})}/>}
      {s.screen==='upload'&&<UploadScreen roleLabel={role?.label??''} demo={false} coding={role?.track==='coding'} tab={s.tab} file={s.file} link={s.link}
        canAnalyze={canAnalyze} submitting={s.submitting} error={s.error} onTabChange={tab=>update({tab})}
        onFile={file=>file&&update({file:{name:file.name,size:formatFileSize(file.size),file},error:null})}
        onRemoveFile={()=>update({file:null})} onLinkChange={link=>update({link})} onAnalyze={()=>void start()}/>}
      {s.screen==='analyzing'&&<AnalyzingScreen stage={s.stage} summary={summary} demo={demo} error={s.error}
        onRetry={()=>{if(s.runId)update({error:null});else update({screen:demo?'role':'upload',error:null});}}/>}
      {s.screen==='ready'&&<ReadyScreen totalSeconds={totalSeconds} questionCount={total}
        limitation={{requested:questionCount,status:s.result?.status??'',issues:s.result?.qualityIssues??[],storageError:s.storageError,demo,notice:s.result?.exampleNotice}}
        onStart={()=>update({screen:'question',startedAt:Date.now(),questionStartedAt:Date.now()})}/>}
      {s.screen==='question'&&<QuestionScreen index={s.questionIndex} questionCount={total} question={questions[s.questionIndex]}
        answer={s.answer} secondsLeft={s.secondsLeft} totalSeconds={totalSeconds} chipsLabel={summary.chipsLabel} chips={summary.chips}
        runId={s.runId??undefined} assets={s.result?.sourceAssets} demo={demo} saveState={s.saveState} saveError={s.error}
        onAnswerChange={answer=>!pending.current&&update({answer})} onSubmit={()=>void submit()}/>}
      {s.screen==='complete'&&<CompleteScreen roleLabel={role?.label??''} answeredCount={s.answers.filter(a=>a.answer.trim()).length} questionCount={total}
        elapsed={formatElapsed(s.answers.reduce((n,a)=>n+a.seconds,0))} saveError={s.error} saveState={s.saveState} savedStorage="supabase"
        onRetry={()=>void submit()} onHome={home}/>}
    </main>
  </div>;
}
