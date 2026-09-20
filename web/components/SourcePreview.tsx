"use client";
import { useState } from 'react';
import type { ClientQuestion, SourceAsset } from '@/lib/types';

export function SourcePreview({runId,anchors,assets,demo}: {runId?:string;anchors?:ClientQuestion['anchors'];assets?:SourceAsset[];demo?:boolean}) {
  const [view,setView]=useState<{url:string;kind:string;text?:string;page:number}|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  if(!runId) return demo ? <p className="screen-subtitle">예제 포트폴리오는 <a href="/dashboard">관리자 패널</a>에서 확인할 수 있어요.</p> : null;
  const ids=[...new Set((anchors??[]).map(a=>a.assetId))];
  const linked=assets?.filter(a=>ids.includes(a.id)||a.id==='pdf')??[];
  if(!linked.length)return <p className="screen-subtitle">연결된 원문 미리보기가 없어요.</p>;
  const open=async(asset:SourceAsset)=>{
    setBusy(true);setError('');
    try {
      const res=await fetch(`/api/analyze/${runId}/source?asset=${encodeURIComponent(asset.id)}`,{cache:'no-store'});
      const body=await res.json();if(!res.ok)throw new Error(body.error||'원문을 열지 못했어요.');
      let text:string|undefined;
      if(body.kind==='code'){const source=await fetch(body.url);if(!source.ok)throw new Error('원문 링크가 만료됐어요. 다시 열어주세요.');text=await source.text();}
      setView({...body,text});
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <div className="source-preview">
    <div className="history-actions">{linked.map(a=><button key={a.id} type="button" className="btn-secondary" disabled={busy} onClick={()=>void open(a)}>
      {a.kind==='pdf'?'원본 PDF':a.kind==='code'?'코드 원문':`${a.page}페이지 근거 영역`}</button>)}</div>
    {busy&&<p role="status">원문을 여는 중…</p>}{error&&<p role="alert">{error}</p>}
    {view&&(view.kind==='pdf'?<a href={view.url} target="_blank" rel="noopener noreferrer">원본 PDF 열기 (비공개 · 60초 링크)</a>:
      view.kind==='code'?<pre>{view.text}</pre>:<img src={view.url} alt={`${view.page}페이지의 질문 연결 영역`} onError={()=>setError('이미지 링크가 만료됐어요. 다시 열어주세요.')}/>)}
  </div>;
}
