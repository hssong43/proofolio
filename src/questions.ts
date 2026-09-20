import * as z from 'zod';
import {normalize, QuestionDrafts, GroundedQuestionReviews} from './schema.ts';
import type {Question, QuestionCard, QuestionDraft, QuestionPlan, ResolvedEvidence,FocusTarget,FocusCoverage,Track} from './schema.ts';
import {QUESTION_PROMPT, QUESTION_REVIEW_PROMPT} from './prompts.ts';
import {SchemaValidationError} from './llm.ts';
import type {Generate,Metrics,ModelRequest} from './llm.ts';
export type Request = <T>(kind:string,schema:z.ZodType<T>,args:Omit<ModelRequest,'kind'|'schema'|'model'>,
  check?:(data:T)=>void)=>Promise<T>;
// Shared by the PDF pipeline and evidence replay: identical routing, validation and one format retry.
export function modelRequest(generate:Generate,stats:Metrics,options:{model:string;skimModel?:string;reviewModel?:string;
  questionModel?:string;questionMaxOutputTokens?:number;signal?:AbortSignal;
  onRequest?:(request:ModelRequest,attempt:number)=>void}):Request {
  return async(kind,schema,initial,check)=>{
    const model=['DocumentMap','PageIndex'].includes(kind)?(options.skimModel??options.model):
      kind==='QuestionSet'?(options.questionModel??options.model):['Reviews','QuestionReviews'].includes(kind)?(options.reviewModel??options.model):options.model;
    let args=initial;
    for(let attempt=1;attempt<=2;attempt++){
      options.signal?.throwIfAborted();
      const request:ModelRequest={kind,schema,model,thinkingLevel:['DesignExtraction','MarketingExtraction','Reviews','QuestionReviews','QuestionSet'].includes(kind)?'MEDIUM':'LOW',
        ...(['gemini-3.1-pro-preview','google/gemini-3.1-pro-preview'].includes(model)?{maxOutputTokens:32768}:{}),...args,
        ...(kind==='QuestionSet'&&options.questionMaxOutputTokens!==undefined?{maxOutputTokens:options.questionMaxOutputTokens}:{})};
      options.onRequest?.(request,attempt);
      stats.model_calls++;const start=performance.now();
      try{const raw=await generate(request);let parsed;
        try{parsed=schema.parse(raw);check?.(parsed);}catch(e){throw new SchemaValidationError(e instanceof z.ZodError?'출력 필드/스키마 오류.':(e as Error).message);}
        return parsed;
      }catch(e){if(!(e instanceof SchemaValidationError)||attempt===2)throw e;
        args={...args,prompt:args.prompt+'\n이전 응답의 형식 검사 오류: '+e.message+'\n같은 원본을 보고 다시 작성한다. 출처를 만들거나 조건을 무시하지 않는다.'};
      }finally{stats.stages.push({stage:kind,attempt,elapsed_ms:Math.round(performance.now()-start)});}
    }throw new Error('Unreachable');
  };
}
export type QuestionCheck = {candidate_index:number; evidence_id:string; status:'accepted'|'rejected'; reasons:string[];round?:number};
type SelectedPoint=FocusTarget&{id:string};
export function questionFocusErrors(plan:QuestionPlan,source:ResolvedEvidence,point:SelectedPoint|undefined) {
  if(!point)return source.focus_target_id===null?[]:['missing_selected_point'];
  const pages=new Set(source.anchors.map(a=>a.page));
  return [point.anchor_page,...point.required_context_pages].some(n=>!pages.has(n))?['question_missing_required_context']:[];
}
const pageReference=/(?:\b(?:page|pages|p\.)\s*\d+|\d+\s*(?:페이지|쪽))/i;
const sourceQuestionKey=(question:string,anchors:ResolvedEvidence['anchors'])=>
  JSON.stringify([normalize(question).replace(/[\p{P}\p{S}\s]/gu,''),anchors[0]?.region_id]);
const questionTaskKey=(plan:QuestionPlan,source:ResolvedEvidence)=>JSON.stringify([plan.angle,plan.aspect??null,
  [...new Set(source.anchors.map(a=>JSON.stringify([a.region_id,normalize(a.quote??''),normalize(a.visual_description??'')])))].sort()]);
export function materializeQuestion(plan:Question & QuestionPlan,source:ResolvedEvidence):QuestionDraft {
  const anchor=source.anchors[0],fact=anchor?.quote??anchor?.visual_description;
  if(!fact)throw new Error('질문 출처가 없습니다.');
  const quotes=[...new Set(source.anchors.flatMap(a=>a.quote?[a.quote]:[]))].map(q=>'원문: '+q);
  // Visual prose is fallible navigation metadata, not a fact we need to repeat in the question.
  const prefix=[...(!anchor.quote?['연결된 시각 자료를 기준으로 답해 주세요.']:[]),...quotes].join('\n');
  return {...plan,question:prefix+'\n'+plan.question,
    answer_target:`${anchor.region_id}: ${plan.intent}`};
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
type CoverageRequirement=FocusCoverage['checks'][number]['source_requirements'][number];
function coversSource(anchors:ResolvedEvidence['anchors'],required:CoverageRequirement) {
  return anchors.some(a=>a.region_id===required.region_id&&(required.quote===null?
    a.quote===null&&!!a.visual_description:a.quote!==null&&normalize(required.quote).length>0&&normalize(a.quote)===normalize(required.quote)));
}
export function questionQuality(cards:QuestionCard[],selectedPointIds:string[],assessments:FocusCoverage[]=[]) {
  const coverage=selectedPointIds.map(id=>{
    const question_ids=cards.filter(q=>q.focus_target_id===id&&q.focus_check?.matches===true).map(q=>q.id);
    const assessment=assessments.find(a=>a.focus_target_id===id);
    const checks=(assessment?.checks??[]).map(c=>{
      const required=c.source_requirements??[];
      const linked=cards.filter(q=>question_ids.includes(q.id)&&c.question_ids.includes(q.id)&&required.some(r=>coversSource(q.anchors,r)));
      const missing_source_requirements=required.filter(r=>!linked.some(q=>coversSource(q.anchors,r)));
      return {...c,question_ids:linked.map(q=>q.id),discarded_question_ids:c.question_ids.filter(id=>!linked.some(q=>q.id===id)),
        missing_source_requirements,complete:required.length>0&&missing_source_requirements.length===0};
    });
    return {focus_target_id:id,question_ids,checks,complete:checks.length>0&&checks.every(c=>c.complete),
      missing_aspects:checks.filter(c=>!c.complete).map(c=>c.aspect)};
  });
  const missing=coverage.filter(p=>!p.complete).map(p=>p.focus_target_id);
  const substantive=cards.filter(q=>q.angle&&q.angle!=='ownership').length;
  const issues=[...(cards.length<3?['fewer_than_three_questions']:[]),...(missing.length?['selected_points_uncovered']:[]),
    ...(substantive<2?['insufficient_substantive_questions']:[]),...(cards.filter(q=>q.angle==='ownership').length>1?['repeated_ownership_questions']:[])];
  return {status:issues.length?'needs_review' as const:'ready' as const,coverage,missing_focus_target_ids:missing,
    substantive_questions:substantive,issues,verification:'automated_source_checks_not_independent_accuracy_proof'};
}
export const DEFAULT_MAX_QUESTIONS=10;
export async function generateQuestions(evidence:ResolvedEvidence[],request:Request,options:{
  track?:Track;selectedPoints:SelectedPoint[];contextImages?:Array<[string,Uint8Array]>;evidenceOnly?:boolean;
  maxQuestions?:number;
  imagesFor:(cards:Array<{question_id:string;source:ResolvedEvidence}>)=>Promise<Array<[string,Uint8Array]>>;
}) {
  const eligible=evidence.filter(e=>e.question_eligible),maxQuestions=options.maxQuestions??DEFAULT_MAX_QUESTIONS;
  if(!Number.isInteger(maxQuestions)||maxQuestions<1||maxQuestions>DEFAULT_MAX_QUESTIONS)throw new Error('최대 질문 수는 1~10입니다.');
  const checks:QuestionCheck[]=[];let cards:QuestionCard[]=[],focusCoverage:FocusCoverage[]=[];
  if(!eligible.length)return {cards,checks,focusCoverage};
  const selectedPointIds=options.selectedPoints.map(p=>p.id),pointById=new Map(options.selectedPoints.map(p=>[p.id,p]));
  // Do not pass skim hypotheses, translated statements or reviewer narrative as facts.
  const sources=eligible.map(e=>({id:e.id,project_key:e.project_key,category:e.category,focus_target_id:e.focus_target_id,
    anchors:e.anchors,unknown_fields:e.unknown_fields,
    focus_intent:pointById.get(e.focus_target_id??'')?.topic??null,
    required_pages:options.selectedPoints.filter(p=>p.id===e.focus_target_id).flatMap(p=>[p.anchor_page,...p.required_context_pages])}));
  const byId=new Map(eligible.map(e=>[e.id,e])),quarantined=new Set<string>(),rejectedTasks=new Set<string>();let offset=0;
  for(let round=1;round<=2;round++){
  const quality=questionQuality(cards,selectedPointIds,focusCoverage);
  const response=await request('QuestionSet',QuestionDrafts,{
    images:options.evidenceOnly?undefined:options.contextImages??await options.imagesFor(eligible.filter(e=>!quarantined.has(e.id)).map(source=>({question_id:'source:'+source.id,source}))),
    prompt:QUESTION_PROMPT+(options.evidenceOnly?'\n이번 입력은 검증된 근거 JSON만 제공하며 PDF/이미지는 제공하지 않는다. 이미지를 직접 보았다고 표현하지 않는다. anchors의 원문·시각 관찰 외의 색상·배치·대상·관계를 상상하지 않는다. 자료 구분이 명시되지 않으면 먼저 조건부로 확인한다.':'')+'\n선택 직군: '+(options.track??'design')+
    '\n기존 통과 질문(반복하지 않는다): '+JSON.stringify(cards.map(q=>({evidence_id:q.evidence_id,question:q.question,answer_target:q.answer_target})))+
    '\n미충족 조건: '+JSON.stringify({missing_focus_target_ids:quality.missing_focus_target_ids,question_count:cards.length,
      missing_verified_sources:quality.coverage.flatMap(p=>p.checks.filter(c=>!c.complete).map(c=>({focus_target_id:p.focus_target_id,
        source_requirements:c.missing_source_requirements})))})+
    '\n이전 제외 이유: '+JSON.stringify(checks.filter(c=>c.status==='rejected'))+
    '\n근거 데이터:\n'+JSON.stringify(sources.filter(s=>!quarantined.has(s.id)))});
  const seenIds=new Set(cards.map(q=>q.evidence_id)),seenText=new Set(cards.map(q=>sourceQuestionKey(q.question,q.anchors)));
  const pending:Array<{question_id:string;question:QuestionDraft;source:ResolvedEvidence;index:number}>=[];
  for(const [index,plan] of response.questions.entries()){
    if(quarantined.has(plan.evidence_id)){checks.push({candidate_index:offset+index+1,evidence_id:plan.evidence_id,status:'rejected',reasons:['previous_source_region_failure'],round});continue;}
    const original=byId.get(plan.evidence_id),source=original?{...original,anchors:plan.anchor_indices.map(i=>original.anchors[i-1]).filter(a=>!!a)}:undefined;
    if(!source?.anchors.length||source.anchors.length!==plan.anchor_indices.length){checks.push({candidate_index:offset+index+1,evidence_id:plan.evidence_id,status:'rejected',reasons:['unknown_question_anchor'],round});continue;}
    const q=materializeQuestion(plan,source);
    // Immutable source text is displayed separately from authored prose; never reinterpret its numerals as new claims.
    const errors=questionErrors(plan,source,seenIds,new Set());
    if(rejectedTasks.has(questionTaskKey(plan,source)))errors.push('previous_question_task_failure');
    if(q.question.length>1200)errors.push('question_source_length_limit');
    errors.push(...questionFocusErrors(plan,source,pointById.get(source.focus_target_id??'')));
    if(seenText.has(sourceQuestionKey(q.question,source.anchors)))errors.push('duplicate_question');
    if(!source||source.anchors.length!==q.anchor_indices.length)errors.push('unknown_question_anchor');
    if(q.angle==='ownership'&&[...cards,...pending.map(p=>p.question)].some(c=>c.angle==='ownership'))errors.push('repeated_ownership_question');
    const primary=(anchors:ResolvedEvidence['anchors'])=>normalize(anchors[0]?.quote??anchors[0]?.visual_description??'');
    if([...cards,...pending.map(p=>({...p.question,anchors:p.source.anchors}))].some(c=>
      c.angle===q.angle&&c.aspect===q.aspect&&c.anchors[0]?.region_id===source.anchors[0]?.region_id&&
      primary(c.anchors)===primary(source.anchors)))errors.push('repeated_source_angle');
    if(cards.length+pending.length>=maxQuestions)errors.push('question_limit');
    if(errors.length){checks.push({candidate_index:offset+index+1,evidence_id:q.evidence_id,status:'rejected',reasons:errors,round});continue;}
    seenIds.add(q.evidence_id);seenText.add(sourceQuestionKey(q.question,source.anchors));
    pending.push({question_id:'candidate-'+(offset+index+1),question:q,source:source!,index:offset+index});
  }
  if(pending.length){
    const prior=cards.map(q=>({question_id:q.id,source:{...byId.get(q.evidence_id)!,anchors:q.anchors}}));
    const targets=new Map([...prior,...pending].map(p=>[p.question_id,p.source.focus_target_id]));
    const pendingIds=pending.map(p=>p.question_id);
    const reviewSchema=GroundedQuestionReviews.extend({reviews:z.array(GroundedQuestionReviews.shape.reviews.element.extend({
      question_id:z.enum(pendingIds),
    })).length(pending.length)});
    const reviewed=await request('QuestionReviews',reviewSchema,{images:await options.imagesFor([...prior,...pending]),
      prompt:QUESTION_REVIEW_PROMPT+'\n이미 채택한 질문(새 질문과 답이 중복되면 새 질문을 제외): '+JSON.stringify(cards)+
      '\nreviews에 반환할 새 후보 ID(이 목록만 정확히 한 번씩): '+JSON.stringify(pendingIds)+
      '\n선정 포인트 가설: '+JSON.stringify(options.selectedPoints)+
      '\n검증된 출처 목록(아직 질문하지 않은 자료도 포함; 목록에 있다는 이유로 충족 처리하지 않는다): '+JSON.stringify(eligible.map(e=>({
        focus_target_id:e.focus_target_id,anchors:e.anchors.map(a=>({region_id:a.region_id,quote:a.quote,visual_description:a.visual_description}))})))+
      '\n고정된 핵심 항목(비어 있으면 최초 작성, 있으면 문구·출처·순서 그대로 유지): '+JSON.stringify(focusCoverage.map(c=>({
        focus_target_id:c.focus_target_id,checks:c.checks.map(({question_ids,...definition})=>definition)})))+
      '\n'+JSON.stringify(pending.map(p=>({question_id:p.question_id,...p.question,
        selected_target_hypothesis:pointById.get(p.source.focus_target_id??''),source:{category:p.source.category,anchors:p.source.anchors}})))},data=>{
      const ids=data.reviews.map(r=>r.question_id);
      if(new Set(ids).size!==ids.length||ids.length!==pending.length||pending.some(p=>!ids.includes(p.question_id)))
        throw new Error('질문 검사 ID 누락/중복/추가.');
      const pointIds=data.focus_coverage.map(c=>c.focus_target_id);
      if(new Set(pointIds).size!==pointIds.length||pointIds.length!==selectedPointIds.length||selectedPointIds.some(id=>!pointIds.includes(id)))
        throw new Error('핵심 포인트 검사 ID 누락/중복/추가.');
      if(data.focus_coverage.some(c=>c.checks.some(k=>k.question_ids.some(id=>!targets.has(id)||targets.get(id)!==c.focus_target_id))))
        throw new Error('핵심 포인트에 알 수 없거나 다른 포인트의 질문 연결.');
      if(data.focus_coverage.some(c=>c.checks.some(k=>k.source_requirements.some(r=>
        !eligible.some(e=>e.focus_target_id===c.focus_target_id&&coversSource(e.anchors,r))))))
        throw new Error('핵심 포인트의 검증 출처에 없는 영역/인용.');
      if(focusCoverage.some(c=>JSON.stringify(c.checks.map(({question_ids,...definition})=>definition))!==
        JSON.stringify(data.focus_coverage.find(next=>next.focus_target_id===c.focus_target_id)?.checks.map(({question_ids,...definition})=>definition))))
        throw new Error('고정된 핵심 항목의 누락/변경/출처/순서 오류.');
    });
    const acceptedIds=new Map(cards.map(q=>[q.id,q.id]));
    for(const p of pending){
      const review=reviewed.reviews.find(r=>r.question_id===p.question_id)!;
      const failures=(['region_support','no_added_premise','distinct_answer','addresses_focus'] as const).filter(key=>!review[key]);
      if(p.question.angle!=='ownership'&&!review.substantive)failures.push('addresses_focus');
      const accepted=review.status==='supported'&&!failures.length;
      // An unchanged task cannot win a second vote; revised tasks or source material may still be reviewed.
      if(!accepted)rejectedTasks.add(questionTaskKey(p.question,p.source));
      // An observed source mismatch cannot be repaired by reordering its anchors in the next question round.
      if(!review.region_support)quarantined.add(p.question.evidence_id);
      checks.push({candidate_index:p.index+1,evidence_id:p.question.evidence_id,status:accepted?'accepted':'rejected',round,
        reasons:[`gemini_premise_review:${review.status}`,review.reason,...failures]});
      if(accepted){const {anchor_indices,...question}=p.question;
        acceptedIds.set(p.question_id,'q'+(cards.length+1));
        cards.push({id:'q'+(cards.length+1),...question,project_key:p.source.project_key,anchors:p.source.anchors,
          source_excerpt:p.source.anchors.map(a=>({region_id:a.region_id,quote:a.quote,observation:a.visual_description})),
          focus_target_id:p.source.focus_target_id,focus_check:{matches:true,method:'local_focus_and_context_plus_visual_review',reason:review.reason},
          document_support:p.source.document_support});}
    }
    // Only accepted source-checked questions can satisfy a required aspect; a rejected candidate cannot pad coverage.
    focusCoverage=(reviewed.focus_coverage??[]).map(c=>({...c,checks:c.checks.map(k=>({...k,
      question_ids:k.question_ids.flatMap(id=>acceptedIds.has(id)?[acceptedIds.get(id)!]:[])}))}));
  }
  offset+=response.questions.length;
  if(cards.length>=maxQuestions||questionQuality(cards,selectedPointIds,focusCoverage).status==='ready'||!response.questions.length)break;
  }
  return {cards,checks:checks.sort((a,b)=>a.candidate_index-b.candidate_index),focusCoverage};
}
export function interviewGuide(result:{analysis_plan:{selected_pages:number[]};questions:QuestionCard[];rejected_candidates:unknown[];question_checks:QuestionCheck[]}) {
  const lines=['포트폴리오 확인 인터뷰','분석 페이지: '+result.analysis_plan.selected_pages.join(', '),
    '제출물 내 출처 대조이며 저작·실제 성과·역량·채용 합불의 확정이 아닙니다.',
    '답변 시 직접 결정·수행한 부분과 참고·협업 자료를 구분해 주세요. 참여가 없는 부분은 그렇게 밝혀 주세요.',
    `제외한 근거 후보: ${result.rejected_candidates.length}; 제외한 질문: ${result.question_checks.filter(q=>q.status==='rejected').length}`,''];
  for(const [i,q] of result.questions.entries()){
    lines.push(`${i+1}. [페이지 ${[...new Set(q.anchors.map(a=>a.page))].sort((a,b)=>a-b).join(', ')}] ${q.question}`,
      '연결 영역: '+[...new Set(q.anchors.map(a=>a.region_id))].join(', '),
      `확인 의도: ${q.intent}`,'답변에서 확인할 내용: '+q.listen_for.join(' / '),'');
  }
  return lines.join('\n');
}
