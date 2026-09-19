import * as z from 'zod';
import {normalize, QuestionDrafts, GroundedQuestionReviews} from './schema.ts';
import type {Question, QuestionCard, QuestionDraft, QuestionPlan, ResolvedEvidence,FocusTarget,Track} from './schema.ts';
import {QUESTION_PROMPT, QUESTION_REVIEW_PROMPT} from './prompts.ts';
import type {ModelRequest} from './gemini.ts';
export type Request = <T>(kind:string,schema:z.ZodType<T>,args:Omit<ModelRequest,'kind'|'schema'|'model'>,
  check?:(data:T)=>void)=>Promise<T>;
export type QuestionCheck = {candidate_index:number; evidence_id:string; status:'accepted'|'rejected'; reasons:string[];round?:number};
type SelectedPoint=FocusTarget&{id:string};
const FOCUS_ANGLE={contribution:'ownership',decision:'decision',artifact:'decision',process:'process',measurement:'measurement'} as const;
function expectedAngle(source:ResolvedEvidence,point:SelectedPoint|undefined) {
  // The skim focus enum can disagree with its topic. Verified design/creative choices may answer that topic;
  // the source-image review must still prove topic alignment. Never replace a metric with generic background.
  if(point?.focus==='measurement'&&['decision','alternative','strategy','creative','channel'].includes(source.category))return 'decision';
  return FOCUS_ANGLE[point?.focus??'artifact'];
}
export function questionFocusErrors(plan:QuestionPlan,source:ResolvedEvidence,point:SelectedPoint|undefined) {
  if(!point)return source.focus_target_id===null?[]:['missing_selected_point'];
  const pages=new Set(source.anchors.map(a=>a.page));
  return [...(plan.angle!==expectedAngle(source,point)?['question_focus_mismatch']:[]),
    ...([point.anchor_page,...point.required_context_pages].some(n=>!pages.has(n))?['question_missing_required_context']:[])];
}
const pageReference=/(?:\b(?:page|pages|p\.)\s*\d+|\d+\s*(?:페이지|쪽))/i;
const ANGLES={
  problem:{question:'이 자료가 다루는 핵심 문제 또는 대상은 무엇인가요? 문서에 제시된 내용과 본인의 해석을 구분해 설명해 주세요.',
    intent:'문제와 대상을 이해한 근거 확인',listen_for:['문제 또는 대상의 구체적 설명','문서에 명시된 내용과 해석의 구분']},
  decision:{question:'이 자료에서 중요하다고 보는 선택 한 가지와 그 판단 기준·장단점을 설명해 주세요. 당시 검토한 대안이 있다면 함께 구분해 주세요.',
    intent:'구체적인 선택의 기준과 절충 확인',listen_for:['자료와 연결되는 구체적인 선택','그 선택의 기준과 장단점','당시 대안 검토 여부와 있었다면 비교 기준']},
  process:{question:'이 자료와 관련한 작업 과정은 어떻게 설명할 수 있나요? 직접 수행한 부분이 있다면 문서에 나타난 내용과 구분하고, 변경한 부분이 있다면 그 이유를 설명해 주세요.',
    intent:'작업 과정과 변경 판단 확인',listen_for:['자료에 나타난 작업 과정','직접 수행한 부분의 유무와 있었다면 범위','변경 여부와 있었다면 이유']},
  measurement:{question:'이 자료의 주장이나 결과를 어떤 기준과 조건으로 해석해야 하나요? 명시된 조건과 추가 확인할 조건을 구분하고, 실제로 검증했다면 방법과 한계를 설명해 주세요.',
    intent:'결과 해석에 필요한 조건과 검증 범위 확인',listen_for:['측정 대상·단위·기간·비교 기준과 해당된다면 분모','명시된 조건과 미확인 조건의 구분','검증 여부와 했다면 방법 및 한계']},
  ownership:{question:'이 자료와 본인의 관계는 무엇인가요? 참여한 부분이 있다면 직접 결정·수행한 범위와 그렇지 않은 부분을 구분해 주세요.',
    intent:'자료와 본인의 관계 및 담당 범위 확인',listen_for:['자료와 본인의 관계','참여 여부와 참여했다면 직접 수행한 범위']},
} as const;
const ASPECTS={
  visual_style:{question:'이 영역에 보이는 색·형태·서체 중 핵심적인 표현 선택은 무엇이며, 전달하려는 인상과 어떻게 연결되나요? 당시 검토한 다른 표현이 있다면 그 차이도 설명해 주세요.',
    intent:'해당 영역의 시각 표현 선택 확인',listen_for:['영역에 실제로 보이는 표현 요소','표현과 전달 의도의 연결','대안 검토 여부와 있었다면 차이']},
  information_hierarchy:{question:'이 영역에서 가장 먼저 전달하려는 정보는 무엇인가요? 크기·위치·배치가 그 정보의 우선순위를 어떻게 드러내는지 설명해 주세요.',
    intent:'해당 영역의 정보 우선순위와 배치 판단 확인',listen_for:['우선 전달할 정보','영역에서 확인되는 배치 근거','정보를 덜 강조하거나 제외한 이유']},
  flow:{question:'이 영역에 나타난 화면이나 단계의 연결 구조를 어떻게 해석하나요? 문서에 명시된 연결과 본인의 해석을 구분하고, 직접 순서를 정했다면 그 기준을 설명해 주세요.',
    intent:'해당 영역의 흐름 해석과 순서 결정 확인',listen_for:['명시된 연결과 해석의 구분','흐름에서 요구되는 행동','순서 결정 참여 여부와 참여했다면 판단 기준']},
  message:{question:'연결된 원문·작업물이 누구에게 어떤 내용을 전달하려는 것으로 이해되나요? 소재·문구·키워드 중 관련된 선택을 짚고, 문서에 명시된 의도와 본인의 해석을 구분해 설명해 주세요.',
    intent:'해당 소재와 메시지의 대상·전달 의도 확인',listen_for:['원문·작업물과 연결되는 대상','소재·문구·키워드의 선택 기준','명시된 의도와 해석의 구분']},
  channel:{question:'연결된 자료에 제시된 채널이나 전달 형식의 선택 기준과 한계를 설명해 주세요. 실제 채택·운영 여부와 제안 단계였는지를 구분하고, 다른 채널을 검토했다면 비교 기준도 설명해 주세요.',
    intent:'해당 채널·전달 형식의 선택과 적용 범위 확인',listen_for:['제시된 채널과 선택 근거','실제 운영과 제안의 구분','다른 채널 검토 여부와 비교 기준']},
} as const;
function angleBody(angle:QuestionPlan['angle'],track?:Track,aspect?:QuestionPlan['aspect']){
  if(angle==='decision'&&aspect)return ASPECTS[aspect];
  const body=ANGLES[angle];
  if(angle==='decision'&&track==='design')return {...body,
    question:'이 자료의 시각적 구성이나 사용 흐름에서 핵심적인 선택 한 가지를 짚고, 그 판단 기준·장단점을 설명해 주세요. 당시 검토한 대안이 있다면 함께 구분해 주세요.'};
  if(angle==='decision'&&track==='marketing')return {...body,
    question:'이 자료에 나타난 타깃·메시지·콘텐츠·채널 중 관련된 선택 한 가지를 짚고, 그 판단 기준·장단점을 설명해 주세요. 당시 검토한 대안이 있다면 함께 구분해 주세요.'};
  return body;
}
export function materializeQuestion(plan:QuestionPlan,source:ResolvedEvidence,track?:Track):QuestionDraft {
  const anchor=source.anchors[0],fact=anchor?.quote??anchor?.visual_description;
  if(!fact)throw new Error('질문 출처가 없습니다.');
  const body=angleBody(plan.angle,track,plan.aspect);
  const quotes=[...new Set(source.anchors.flatMap(a=>a.quote?[a.quote]:[]))].map(q=>'원문: '+q);
  // Visual prose is fallible navigation metadata, not a fact we need to repeat in the question.
  const prefix=[...(!anchor.quote?['연결된 시각 자료를 기준으로 답해 주세요.']:[]),...quotes].join('\n');
  return {...plan,question:prefix+'\n'+body.question,
    intent:body.intent,listen_for:[...body.listen_for],answer_target:`${anchor.region_id}: ${body.intent}`};
}
export function questionErrors(q:Question,evidence:ResolvedEvidence|undefined,seenIds:Set<string>,seenText:Set<string>) {
  const errors:string[]=[];
  if(!evidence?.question_eligible)errors.push('unknown_or_ineligible_evidence');
  if(seenIds.has(q.evidence_id))errors.push('duplicate_evidence');
  const text=normalize(q.question).replace(/[\p{P}\p{S}\s]/gu,'');
  if(seenText.has(text))errors.push('duplicate_question');
  const prose=[q.question,q.intent,...q.listen_for].join(' ');
  if(pageReference.test(prose))errors.push('model_authored_page_number');
  // Numerals are allowed only inside a verbatim source phrase, including its subject/unit.
  const quotes=evidence?.anchors.flatMap(a=>a.quote?[normalize(a.quote)]:[])??[];
  const unquoted=prose.replace(/“([^”]+)”|‘([^’]+)’|"([^"]+)"/g,(match,a,b,c)=>{
    const phrase=normalize(a??b??c);
    return quotes.some(q=>q.includes(phrase))&&!/^\p{N}+[\s.%p]*$/u.test(phrase)?'':match;
  });
  if(/\p{N}/u.test(unquoted))errors.push('numeric_premise_requires_source_quote');
  if(/(?:거짓말|신뢰도\s*점수|채용\s*합불|표절.*확정)/.test(prose))errors.push('forbidden_verdict');
  return errors;
}
export function questionQuality(cards:QuestionCard[],selectedPointIds:string[]) {
  const coverage=selectedPointIds.map(id=>({focus_target_id:id,question_ids:cards.filter(q=>q.focus_target_id===id&&q.focus_check?.matches===true).map(q=>q.id)}));
  const missing=coverage.filter(p=>!p.question_ids.length).map(p=>p.focus_target_id);
  const substantive=cards.filter(q=>q.angle&&q.angle!=='ownership').length;
  const issues=[...(cards.length<3?['fewer_than_three_questions']:[]),...(missing.length?['selected_points_uncovered']:[]),
    ...(substantive<2?['insufficient_substantive_questions']:[]),...(cards.filter(q=>q.angle==='ownership').length>1?['repeated_ownership_questions']:[])];
  return {status:issues.length?'needs_review' as const:'ready' as const,coverage,missing_focus_target_ids:missing,
    substantive_questions:substantive,issues,verification:'automated_source_checks_not_independent_accuracy_proof'};
}
export const DEFAULT_MAX_QUESTIONS=5;
export async function generateQuestions(evidence:ResolvedEvidence[],request:Request,options:{
  track?:Track;selectedPoints:SelectedPoint[];maxQuestions?:number;imagesFor:(cards:Array<{question_id:string;source:ResolvedEvidence}>)=>Promise<Array<[string,Uint8Array]>>;
}) {
  const eligible=evidence.filter(e=>e.question_eligible),maxQuestions=options.maxQuestions??DEFAULT_MAX_QUESTIONS;
  const checks:QuestionCheck[]=[];let cards:QuestionCard[]=[];
  if(!eligible.length)return {cards,checks};
  const selectedPointIds=options.selectedPoints.map(p=>p.id),pointById=new Map(options.selectedPoints.map(p=>[p.id,p]));
  // Do not pass skim hypotheses, translated statements or reviewer narrative as facts.
  const sources=eligible.map(e=>({id:e.id,project_key:e.project_key,category:e.category,focus_target_id:e.focus_target_id,
    anchors:e.anchors,unknown_fields:e.unknown_fields,
    required_angle:expectedAngle(e,pointById.get(e.focus_target_id??'')),
    required_pages:options.selectedPoints.filter(p=>p.id===e.focus_target_id).flatMap(p=>[p.anchor_page,...p.required_context_pages])}));
  const byId=new Map(eligible.map(e=>[e.id,e])),quarantined=new Set<string>();let offset=0;
  for(let round=1;round<=2;round++){
  const response=await request('QuestionSet',QuestionDrafts,{prompt:QUESTION_PROMPT+
    '\n기존 통과 질문(반복하지 않는다): '+JSON.stringify(cards.map(q=>({evidence_id:q.evidence_id,question:q.question,answer_target:q.answer_target})))+
    '\n미충족 조건: '+JSON.stringify(questionQuality(cards,selectedPointIds))+
    '\n이전 제외 이유: '+JSON.stringify(checks.filter(c=>c.status==='rejected'))+
    '\n근거 데이터:\n'+JSON.stringify(sources.filter(s=>!quarantined.has(s.id)))});
  const seenIds=new Set(cards.map(q=>q.evidence_id)),seenText=new Set(cards.map(q=>normalize(q.question).replace(/[\p{P}\p{S}\s]/gu,'')));
  const pending:Array<{question_id:string;question:QuestionDraft;source:ResolvedEvidence;index:number}>=[];
  for(const [index,plan] of response.questions.entries()){
    if(quarantined.has(plan.evidence_id)){checks.push({candidate_index:offset+index+1,evidence_id:plan.evidence_id,status:'rejected',reasons:['previous_source_region_failure'],round});continue;}
    const original=byId.get(plan.evidence_id),source=original?{...original,anchors:plan.anchor_indices.map(i=>original.anchors[i-1]).filter(a=>!!a)}:undefined;
    if(!source?.anchors.length||source.anchors.length!==plan.anchor_indices.length){checks.push({candidate_index:offset+index+1,evidence_id:plan.evidence_id,status:'rejected',reasons:['unknown_question_anchor'],round});continue;}
    const q=materializeQuestion(plan,source,options.track);
    // Immutable source text is displayed separately from authored prose; never reinterpret its numerals as new claims.
    const body=angleBody(plan.angle,options.track,plan.aspect);
    const errors=questionErrors({...q,...body,listen_for:[...body.listen_for]},source,seenIds,new Set());
    if(q.question.length>1200)errors.push('question_source_length_limit');
    errors.push(...questionFocusErrors(plan,source,pointById.get(source.focus_target_id??'')));
    if(seenText.has(normalize(q.question).replace(/[\p{P}\p{S}\s]/gu,'')))errors.push('duplicate_question');
    if(!source||source.anchors.length!==q.anchor_indices.length)errors.push('unknown_question_anchor');
    if(q.angle==='ownership'&&[...cards,...pending.map(p=>p.question)].some(c=>c.angle==='ownership'))errors.push('repeated_ownership_question');
    const primary=(anchors:ResolvedEvidence['anchors'])=>normalize(anchors[0]?.quote??anchors[0]?.visual_description??'');
    if([...cards,...pending.map(p=>({...p.question,anchors:p.source.anchors}))].some(c=>
      c.angle===q.angle&&c.aspect===q.aspect&&primary(c.anchors)===primary(source.anchors)))errors.push('repeated_source_angle');
    if(cards.length+pending.length>=maxQuestions)errors.push('question_limit');
    if(errors.length){checks.push({candidate_index:offset+index+1,evidence_id:q.evidence_id,status:'rejected',reasons:errors,round});continue;}
    seenIds.add(q.evidence_id);seenText.add(normalize(q.question).replace(/[\p{P}\p{S}\s]/gu,''));
    pending.push({question_id:'candidate-'+(offset+index+1),question:q,source:source!,index:offset+index});
  }
  if(pending.length){
    const reviewed=await request('QuestionReviews',GroundedQuestionReviews,{images:await options.imagesFor(pending),
      prompt:QUESTION_REVIEW_PROMPT+'\n이미 채택한 질문(새 질문과 답이 중복되면 새 질문을 제외): '+JSON.stringify(cards)+
      '\n'+JSON.stringify(pending.map(p=>({question_id:p.question_id,...p.question,
        selected_target_hypothesis:pointById.get(p.source.focus_target_id??''),source:{category:p.source.category,anchors:p.source.anchors}})))},data=>{
      const ids=data.reviews.map(r=>r.question_id);
      if(new Set(ids).size!==ids.length||ids.length!==pending.length||pending.some(p=>!ids.includes(p.question_id)))
        throw new Error('질문 검사 ID 누락/중복/추가.');
    });
    for(const p of pending){
      const review=reviewed.reviews.find(r=>r.question_id===p.question_id)!;
      const failures=(['region_support','no_added_premise','distinct_answer','addresses_focus'] as const).filter(key=>!review[key]);
      if(p.question.angle!=='ownership'&&!review.substantive)failures.push('addresses_focus');
      const accepted=review.status==='supported'&&!failures.length;
      // An observed source mismatch cannot be repaired by reordering its anchors in the next question round.
      if(!review.region_support)quarantined.add(p.question.evidence_id);
      checks.push({candidate_index:p.index+1,evidence_id:p.question.evidence_id,status:accepted?'accepted':'rejected',round,
        reasons:[`gemini_premise_review:${review.status}`,review.reason,...failures]});
      if(accepted){const {anchor_indices,...question}=p.question;
        cards.push({id:'q'+(cards.length+1),...question,project_key:p.source.project_key,anchors:p.source.anchors,
          source_excerpt:p.source.anchors.map(a=>({region_id:a.region_id,quote:a.quote,observation:a.visual_description})),
          focus_target_id:p.source.focus_target_id,focus_check:{matches:true,method:'local_focus_and_context_plus_visual_review',reason:review.reason},
          document_support:p.source.document_support});}
    }
  }
  offset+=response.questions.length;
  if(questionQuality(cards,selectedPointIds).status==='ready'||!response.questions.length)break;
  }
  return {cards,checks:checks.sort((a,b)=>a.candidate_index-b.candidate_index)};
}
export function interviewGuide(result:{analysis_plan:{selected_pages:number[]};questions:QuestionCard[];rejected_candidates:unknown[];question_checks:QuestionCheck[]}) {
  const lines=['포트폴리오 확인 인터뷰','분석 페이지: '+result.analysis_plan.selected_pages.join(', '),
    '제출물 내 출처 대조이며 저작·실제 성과·역량·채용 합불의 확정이 아닙니다.',
    '답변 시 직접 결정·수행한 부분과 참고·협업 자료를 구분해 주세요. 참여가 없는 부분은 그렇게 밝혀 주세요.',
    `제외한 근거 후보: ${result.rejected_candidates.length}; 제외한 질문: ${result.question_checks.filter(q=>q.status==='rejected').length}`,''];
  for(const [i,q] of result.questions.entries()){
    lines.push(`${i+1}. [페이지 ${[...new Set(q.anchors.map(a=>a.page))].sort((a,b)=>a-b).join(', ')}] ${q.question}`,
      `확인 의도: ${q.intent}`,'답변에서 확인할 내용: '+q.listen_for.join(' / '),'');
  }
  return lines.join('\n');
}
