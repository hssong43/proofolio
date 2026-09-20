import type {ClientResult,PublicTest,Submission,TestSummary} from '../lib/types';
export const runId='00000000-0000-4000-8000-000000000001';
export const submissionId='00000000-0000-4000-8000-000000000002';
export const testId='00000000-0000-4000-8000-000000000003';
export const result:ClientResult={status:'needs_review',qualityIssues:[],pageCount:6,projects:[{key:'p',title:'합성 프로젝트',pages:[1]}],
  evidenceCount:6,estimatedCostUsd:0,maxQuestions:10,questions:Array.from({length:6},(_,i)=>({id:'q'+(i+1),prompt:'합성 질문 '+(i+1)+': 선택 기준을 설명해주세요.',
    quotes:['합성 근거 '+(i+1)],notes:[],pages:[1],projectTitle:'합성 프로젝트',intent:'판단 기준 확인',listenFor:['역할과 기준'],answerTarget:'설명'}))};
export const testRecord:TestSummary={id:testId,code:'ABC234',title:'합성 채용 테스트',role:'designer',
  startsAt:new Date(Date.now()-3600000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),
  createdAt:new Date().toISOString(),totalSeconds:40,questionCount:10,status:'open',submissionCount:1,completedCount:1};
export const publicTest:PublicTest={testId,title:testRecord.title,role:'designer',roleLabel:'디자이너',
  startsAt:testRecord.startsAt,endsAt:testRecord.endsAt,totalSeconds:40,questionCount:10};
export const submission:Submission={id:submissionId,testId,candidate:{name:'합성 응시자',birthDate:'2000-01-01',phone:'01000000000'},
  joinedAt:new Date().toISOString(),completedAt:null,state:'joined',runId:null};
