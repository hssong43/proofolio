"use client";
import type { ClientQuestion, SubmissionScore } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { formatDateTime } from '@/lib/period';

const level=(score:number)=>score>=80?'high':score>=60?'mid':'low';
export const scoreLabel=(score:SubmissionScore|null|undefined)=>!score?'-':score.state==='complete'&&score.overallScore!==null?score.overallScore+'점':
  score.state==='failed'?'채점 실패':'채점 중';

/** 제출 상단: 종합 점수, 모델, 재채점. 합불 판정은 없다. */
export function ScoreSummary({score,busy,onRescore}:{score:SubmissionScore|null|undefined;busy:boolean;onRescore:()=>void}) {
  const complete=score?.state==='complete'&&score.overallScore!==null;
  return <section className="result-panel" data-state={score?.state??'none'} aria-label="AI 채점 요약">
    <div className="result-main">
      <span className="result-score">{complete?<>{score!.overallScore}<span className="result-unit">점</span></>:'-'}</span>
      <div className="result-meta">
        <strong>AI 채점 종합 점수</strong>
        <span>{!score?'아직 채점되지 않았어요.':score.state==='complete'?`${score.model??'모델'} · ${score.scoredAt?formatDateTime(score.scoredAt):''}`:
          score.state==='failed'?'채점 실패: '+(score.error??'원인 미상'):'채점 중이에요. 잠시 후 새로고침해주세요.'}</span>
        <span className="field-hint">질문 의도·확인 사항을 모두 다루면 80점, 누락이 있으면 60점까지 감점, 모두 다룬 경우에만 분량·논리·창의성으로 100점까지 가산하는 참고 지표예요. 합불 판정이 아니에요.</span>
      </div>
    </div>
    <div className="result-actions">
      {score?.state!=='running'&&<button type="button" className="btn-secondary" disabled={busy} onClick={onRescore}>{busy?'요청 중…':score?.state==='complete'?'다시 채점':'채점 실행'}</button>}
      {score?.state==='running'&&<StatusBadge status="scoring"/>}
    </div>
  </section>;
}

/** 문항 아래: 점수, 포함/누락 항목, 등급, 코멘트 */
export function QuestionScore({question,score}:{question:ClientQuestion;score:SubmissionScore|null|undefined}) {
  const item=score?.state==='complete'?score.items.find(i=>i.questionId===question.id):undefined;
  if(!item)return null;
  return <div className="qa-eval" data-level={level(item.score)}>
    <div className="qa-eval-head"><span className="score-pill" data-level={level(item.score)}>{item.score}점</span>
      <span className="qa-eval-breakdown">포함 {item.coverageScore} + 가산 {item.bonus} · 분량 {item.depth}/3 · 논리 {item.logic}/4 · 창의 {item.creativity}/3</span></div>
    <ul className="coverage-list">{item.coverage.map((c,k)=><li key={k} className="coverage-item" data-covered={c.covered}>
      <span className="coverage-mark" aria-label={c.covered?'포함':'누락'}>{c.covered?'✓':'✗'}</span>
      <span className="coverage-text">{k===0?'의도: ':''}{c.item}{c.covered&&c.evidence?<em className="coverage-evidence">“{c.evidence}”</em>:null}</span></li>)}</ul>
    <p className="qa-eval-comment">{item.comment}</p>
  </div>;
}
