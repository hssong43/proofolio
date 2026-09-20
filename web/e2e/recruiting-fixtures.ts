import type {ClientResult,PublicTest,Submission,SubmissionScore,TestSummary} from '../lib/types';
export const runId='00000000-0000-4000-8000-000000000001';
export const submissionId='00000000-0000-4000-8000-000000000002';
export const testId='00000000-0000-4000-8000-000000000003';
export const result:ClientResult={status:'needs_review',qualityIssues:[],pageCount:6,projects:[{key:'p',title:'합성 프로젝트',pages:[1]}],
  evidenceCount:6,estimatedCostUsd:0,maxQuestions:10,questions:Array.from({length:6},(_,i)=>({id:'q'+(i+1),prompt:'합성 질문 '+(i+1)+': 선택 기준을 설명해주세요.',
    quotes:['합성 근거 '+(i+1)],notes:[],pages:[1],projectTitle:'합성 프로젝트',intent:'판단 기준 확인',listenFor:['역할과 기준'],answerTarget:'설명'}))};
export const testRecord:TestSummary={id:testId,code:'ABC234',title:'합성 채용 테스트',role:'designer',
  startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),
  createdAt:new Date().toISOString(),totalSeconds:40,questionCount:10,status:'open',submissionCount:1,completedCount:1,scoredCount:1,averageScore:74};
export const publicTest:PublicTest={testId,title:testRecord.title,role:'designer',roleLabel:'디자이너',
  startsAt:testRecord.startsAt,endsAt:testRecord.endsAt,totalSeconds:40,questionCount:10};
export const submission:Submission={id:submissionId,testId,candidate:{name:'합성 응시자',birthDate:'2000-01-01',phone:'01000000000'},
  joinedAt:new Date().toISOString(),completedAt:null,state:'joined',runId:null};

/** 6문항 합성 채점: q1 전부 포함, q2~q4 일부 누락, q5 항목 전부 누락(답변은 있음), q6 빈 답변. 평균 74. */
export const score:SubmissionScore={state:'complete',model:'anthropic/claude-opus-5',overallScore:74,error:null,scoredAt:new Date().toISOString(),costUsd:0.0421,
  items:result.questions.map((q,i)=>{
    const relevance=i===5?'none':i===0?'full':'partial';
    const covered=[i<5,i===0||i===1||i===2];
    const coverage=[q.intent,...q.listenFor].map((item,k)=>({item,covered:relevance!=='none'&&covered[k],evidence:relevance!=='none'&&covered[k]?'합성 근거 구절 '+(i+1):''}));
    const missing=coverage.filter(c=>!c.covered).map(c=>c.item);
    const score=[100,88,84,73,62,0][i],coverageScore=[80,70,70,70,60,0][i],bonus=[20,18,14,3,2,0][i];
    return {questionId:q.id,score,coverageScore,bonus,relevance,coverage,missing,depth:[3,3,2,1,1,0][i],logic:[4,4,3,0,0,0][i],creativity:[3,2,2,1,0,0][i],
      comment:i===5?'답변이 없어요.':'합성 코멘트 '+(i+1)+': 판단 기준을 설명했고 '+(missing.length?'역할 분담은 빠졌어요.':'역할과 기준을 모두 다뤘어요.')};
  })};
