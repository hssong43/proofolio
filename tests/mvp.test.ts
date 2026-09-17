import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,rgb} from 'pdf-lib';
import {DocumentMap, QuestionPlan, type QuestionCard, type ResolvedEvidence} from '../src/schema.ts';
import {normalizeMap,validateMap,validateAnchors,selectPages,analyzePdf,localEvidenceChecks,atomicArtifacts} from '../src/pipeline.ts';
import {pageTiles,pageBox,openRenderer,renderPage,numericQuoteIssue} from '../src/pdf.ts';
import {questionQuality,questionFocusErrors,generateQuestions,materializeQuestion,type Request} from '../src/questions.ts';
import {Budget,buildPayload} from '../src/gemini.ts';

test('v0.6 normalizes redundant context without hiding missing/cross-project references or project limits',()=>{
  const map=DocumentMap.parse({pages:Array.from({length:20},(_,i)=>({page:i+1,role:'project',readability:'readable',note:'work'})),
    projects:Array.from({length:20},(_,i)=>({key:'p'+i,title:'Work '+i,pages:[i+1]})),focus_targets:[{
      project_key:'p0',anchor_page:1,focus:'decision',specificity:'concrete_action',context_status:'located',reason:'core',
      required_context_pages:[1,1],optional_context_pages:[1],importance:'core',topic:'layout'}]});
  validateMap(normalizeMap(map),20);assert.deepEqual(map.focus_targets[0].required_context_pages,[]);
  map.focus_targets[0].required_context_pages=[2];validateMap(normalizeMap(map),20);
  const plan=selectPages(map);assert.equal(plan.deferred_points.find(p=>p.id==='t1')?.defer_reason,'invalid_point_references');
  assert.deepEqual(plan.deferred_points.find(p=>p.id==='t1')?.required_context_pages,[2]);
});
test('v0.7.4 bad optional or duplicate focus candidates are deferred whole without contaminating valid selections',()=>{
  const point={project_key:'a',anchor_page:1,focus:'decision',specificity:'concrete_action',context_status:'located',reason:'fixture',
    required_context_pages:[],optional_context_pages:[]};
  const map=DocumentMap.parse({pages:[1,2].map(page=>({page,role:'project',readability:'readable',note:'work'})),
    projects:[{key:'a',title:'A',pages:[1]},{key:'b',title:'B',pages:[2]}],
    focus_targets:[{...point,optional_context_pages:[2]},point,point,{...point,project_key:'unknown'}]});
  validateMap(map,2);const plan=selectPages(map);
  assert.deepEqual(plan.selected_points.map(p=>p.id),['t2','t5']);
  assert.deepEqual(plan.deferred_points.map(p=>p.defer_reason),['invalid_point_references','duplicate_focus_target','invalid_point_references']);
  assert.deepEqual(plan.deferred_points[0].optional_context_pages,[2]);
  assert.ok(plan.selected_points.every(p=>p.project_key!=='unknown'));
});
test('v0.6 core point beats cheap early role summary but never splits mandatory context',()=>{
  const target=(n:number,importance:'core'|'minor')=>({project_key:'a',anchor_page:n,focus:'decision' as const,
    specificity:'concrete_action' as const,context_status:'located' as const,reason:'reason',importance,
    required_context_pages:n===5?[4]:[],optional_context_pages:[]});
  const map=DocumentMap.parse({pages:Array.from({length:5},(_,i)=>({page:i+1,role:'project',readability:'readable',note:'work'})),
    projects:[{key:'a',title:'A',pages:[1,2,3,4,5]}],focus_targets:[target(1,'minor'),target(2,'minor'),target(3,'minor'),target(5,'core')]});
  assert.deepEqual(selectPages(map,'focused',2).selected_pages,[4,5]);
  assert.equal(selectPages(map,'focused',1).deferred_points.find(p=>p.anchor_page===5)?.defer_reason,'page_budget');
});
test('v0.6 chunk scan maps overlapping local page numbers back to original physical pages',async()=>{
  const pdf=await PDFDocument.create();for(let i=1;i<=17;i++)pdf.addPage([200+i,300]);let chunks=0;
  const result=await analyzePdf(await pdf.save(),{model:'gemini-test',track:'design',generate:async request=>{
    assert.match(request.prompt,/선택 직군: design/);
    if(request.kind==='PageIndex'){chunks++;const p=await PDFDocument.load(request.pdf!);return {pages:p.getPages().map((page,i)=>({
      page:i+1,role:'other',readability:'readable',note:'page '+(page.getWidth()-200),project_title:null,heading:null,
      key_content:'source '+(page.getWidth()-200),continues_previous:false,referenced_pages:[]}))};}
    assert.equal(request.kind,'DocumentMap');assert.equal(request.pdf,undefined);
    const index=JSON.parse(request.prompt.split('\n').at(-1)!);
    assert.deepEqual(index.map((p:any)=>p.page),Array.from({length:17},(_,i)=>i+1));
    assert.ok(index.every((p:any)=>p.key_content==='source '+p.page));
    return {pages:index.map(({page,role,readability,note}:any)=>({page,role,readability,note})),projects:[],focus_targets:[]};
  }});
  assert.equal(chunks,3);assert.equal(result.status,'insufficient_evidence');
});
test('v0.7.3 direct and tiled scans receive the selected marketing track',async()=>{
  for(const height of [300,2000]){
    const pdf=await PDFDocument.create();pdf.addPage([200,height]);let indices=0;
    await analyzePdf(await pdf.save(),{model:'gemini-test',track:'marketing',generate:async request=>{
      assert.match(request.prompt,/선택 직군: marketing/);
      if(request.kind==='PageIndex'){indices++;return {pages:request.images!.map((_,i)=>({page:i+1,role:'other',readability:'readable',note:'fixture',
        project_title:null,heading:null,key_content:'fixture',continues_previous:false,referenced_pages:[]}))};}
      assert.equal(request.kind,'DocumentMap');
      return {pages:[{page:1,role:'other',readability:'readable',note:'fixture'}],projects:[],focus_targets:[]};
    }});
    assert.equal(indices>0,height===2000);
  }
});
test('v0.6 tall-page crop resolution and normalized tile coordinates',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([100,10000]);
  page.drawRectangle({x:0,y:4900,width:100,height:100,color:rgb(0,1,0)});
  const r=await openRenderer(await pdf.save());try{
    const c=await renderPage(r,1,[500,0,510,1000]);assert.equal(c.width,1600);assert.equal(c.height,1600);
    assert.deepEqual([...c.getContext('2d').getImageData(800,800,1,1).data],[0,255,0,255]);
  }finally{await r.loadingTask.destroy();}
  assert.deepEqual(pageBox([200,100,400,900],[100,250,900,750]),[220,300,380,700]);
  const tiles=pageTiles(100,1000);assert.ok(tiles.length<=8);assert.equal(tiles.at(-1)![2],1000);
  assert.ok(tiles[1][0]<tiles[0][2]);assert.equal(pageTiles(100,10000).length,8);
  assert.equal(pageTiles(100,10000).at(-1)![2],1000);
});
test('v0.6 coverage and participation gates cannot pass on count alone',()=>{
  const cards=[{id:'q1',focus_target_id:'t1',angle:'ownership'},{id:'q2',focus_target_id:'t1',angle:'ownership'},
    {id:'q3',focus_target_id:'t1',angle:'ownership'}] as QuestionCard[];
  const quality=questionQuality(cards,['t1','t2']);assert.equal(quality.status,'needs_review');assert.deepEqual(quality.missing_focus_target_ids,['t1','t2']);
  assert.ok(quality.issues.includes('repeated_ownership_questions'));
});
test('v0.6 question review sees only selected source crops and rejects false support even with supported status',async()=>{
  const evidence={id:'e1',project_key:'a',category:'decision',focus_target_id:'t1',question_eligible:true,unknown_fields:[],
    anchors:[{page:1,region_id:'p1:r1',quote:'개인 프로젝트',visual_description:null,box:[0,0,1000,1000]},
      {page:2,region_id:'p2:r2',quote:'별개의 작업',visual_description:null,box:[0,0,1000,1000]}]} as unknown as ResolvedEvidence;
  let rounds=0,seenImages=0;
  const request:Request=async <T>(kind:string,_schema:any,args:any):Promise<T>=>{
    if(kind==='QuestionSet'){rounds++;return {questions:rounds===1?[{evidence_id:'e1',anchor_indices:[1],angle:'decision'}]:[]} as T;}
    assert.equal(args.images[0][0],'p1:r1');seenImages++;
    return {reviews:[{question_id:'candidate-1',status:'supported',reason:'fixture',region_support:true,no_added_premise:false,
      distinct_answer:true,addresses_focus:true,substantive:true}]} as T;
  };
  const result=await generateQuestions([evidence],request,{selectedPoints:[{id:'t1',project_key:'a',anchor_page:1,focus:'decision',specificity:'concrete_action',context_status:'located',reason:'fixture',required_context_pages:[],optional_context_pages:[]}],imagesFor:async rows=>{
    assert.equal(rows[0].source.anchors.length,1);return [[rows[0].source.anchors[0].region_id,new Uint8Array()]];}});
  assert.equal(result.cards.length,0);assert.equal(rounds,2);assert.equal(seenImages,1);
  assert.ok(result.checks[0].reasons.includes('no_added_premise'));
});
test('v0.7 numeric punctuation cannot disappear despite otherwise matching source words',()=>{
  const box=[0,0,1000,1000],spans=[{box,text:'From 2–3 min to ≤ 30 sec for returning users. ROAS +300%. 3–4 unified steps (first-time).'}];
  assert.equal(numericQuoteIssue('From 2 3 min to ≤ 30 sec for returning users',box,spans),'ambiguous_numeric_spacing');
  assert.equal(numericQuoteIssue('From 2–3 min to ≤ 30 sec for returning users',box,spans),null);
  assert.equal(numericQuoteIssue('From 23 min to ≤ 30 sec for returning users',box,spans),'numeric_text_layer_mismatch');
  assert.equal(numericQuoteIssue('ROAS 300%',box,spans),'numeric_text_layer_mismatch');
  assert.equal(numericQuoteIssue('ROAS +300%',box,spans),null);
  assert.equal(numericQuoteIssue('3 4 unified steps (first time)',box,[]),'ambiguous_numeric_spacing');
  assert.equal(numericQuoteIssue('ROAS 250%',box,[]),null);
  assert.equal(numericQuoteIssue('1 네이버 블로그',[0,0,1000,1000],[{box,text:'① 네이버 블로그'}]),'nonverbatim_symbol_transcription');
  assert.equal(numericQuoteIssue('① 네이버 블로그',[0,0,1000,1000],[{box,text:'① 네이버 블로그'}]),null);
});
test('v0.8 map cannot contradict an explicit known project title in the page index',()=>{
  const map=DocumentMap.parse({pages:[1,2,3].map(page=>({page,role:'project',readability:'readable',note:'work'})),
    projects:[{key:'channel',title:'채널 A',pages:[1]},{key:'council',title:'학생회',pages:[2,3]}],focus_targets:[]});
  const index=[{page:2,role:'project' as const,readability:'readable' as const,note:'work',project_title:'채널 A',
    heading:'채널 A (팀 작업)',key_content:'work',continues_previous:false,referenced_pages:[]}];
  assert.throws(()=>validateMap(map,3,index),/indexed_project_title_conflict: page=2/);
  map.projects[0].pages.push(2);map.projects[1].pages=[3];assert.doesNotThrow(()=>validateMap(map,3,index));
  assert.doesNotThrow(()=>validateMap(map,3,[{...index[0],project_title:'다른 하위 작업',heading:'다른 하위 작업'}]));
});
test('v0.8 ranked core topics do not fall back to early pages and distinct same-page choices stay separate',()=>{
  const target=(project_key:string,page:number,topic:string)=>({project_key,anchor_page:page,focus:'decision',
    specificity:'concrete_action',context_status:'located',reason:'fixture',importance:'core',topic,
    required_context_pages:[],optional_context_pages:[]});
  const map=DocumentMap.parse({pages:[1,2,3].map(page=>({page,role:'project',readability:'readable',note:'work'})),
    projects:[{key:'early',title:'Early',pages:[1]},{key:'core',title:'Core',pages:[2,3]}],
    focus_targets:[target('core',3,'독립적인 메시지 선택'),target('core',3,'독립적인 채널 선택'),target('early',1,'부수적인 디자인 선택')]});
  const plan=selectPages(map);assert.equal(plan.selected_points[0].id,'t1');
  assert.deepEqual(new Set(plan.selected_points.map(p=>p.id)),new Set(['t1','t2','t3']));
  assert.equal(plan.deferred_points.length,0);
  map.focus_targets.push(structuredClone(map.focus_targets[0]));
  assert.equal(selectPages(map).deferred_points.find(p=>p.id==='t4')?.defer_reason,'duplicate_focus_target');
});
test('v0.7 cancellation settles the in-flight stage and blocks the next call',async()=>{
  const pdf=await PDFDocument.create();pdf.addPage();const c=new AbortController();let calls=0;
  await assert.rejects(analyzePdf(await pdf.save(),{track:'design',model:'gemini-test',signal:c.signal,generate:async()=>{
    calls++;c.abort(new Error('pause'));
    return {pages:[{page:1,role:'project',readability:'readable',note:'work'}],projects:[{key:'a',title:'A',pages:[1]}],focus_targets:[]};
  }}),/pause/);
  assert.equal(calls,1);
});
test('v0.7 focus IDs alone cannot pass a wrong question angle or cropped-away required page',()=>{
  const point={id:'t1',project_key:'a',anchor_page:1,focus:'measurement' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'measurement',required_context_pages:[2],optional_context_pages:[]};
  const source={focus_target_id:'t1',anchors:[{page:1}]} as ResolvedEvidence;
  const plan={evidence_id:'e',anchor_indices:[1],angle:'problem' as const};
  assert.deepEqual(questionFocusErrors(plan,source,point),['question_focus_mismatch','question_missing_required_context']);
  source.anchors.push({page:2} as any);
  assert.deepEqual(questionFocusErrors({...plan,angle:'measurement'},source,point),[]);
  source.category='creative';
  assert.deepEqual(questionFocusErrors({...plan,angle:'decision'},source,point),[]);
  source.category='objective';
  assert.ok(questionFocusErrors(plan,source,point).includes('question_focus_mismatch'));
  const cards=[{id:'q1',focus_target_id:'t1',angle:'measurement'}] as QuestionCard[];
  assert.deepEqual(questionQuality(cards,['t1']).missing_focus_target_ids,['t1']);
  cards[0].focus_check={matches:true,method:'fixture',reason:'fixture'};
  assert.deepEqual(questionQuality(cards,['t1']).missing_focus_target_ids,[]);
});
test('v0.7.5 missing required source context is rejected before paid review, not patched with unrelated evidence',()=>{
  const point={id:'t',project_key:'a',anchor_page:1,focus:'process' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'fixture',required_context_pages:[2],optional_context_pages:[]};
  const project={key:'a',title:'A',pages:[5,7]},inventory=new Map([[5,{regions:[{key:'r1'}]}],[7,{regions:[{key:'r2'}]}]]) as any;
  const e={focus_target_id:'t',anchors:[{page:1,region_key:'r1'}]} as any;
  assert.throws(()=>validateAnchors(e,project,inventory,[point],'focused'),/evidence_missing_required_context/);
  e.anchors.push({page:2,region_key:'r2'});assert.doesNotThrow(()=>validateAnchors(e,project,inventory,[point],'focused'));
});
test('v0.7.1 distinct work on one point is allowed but the same source cannot inflate question count',async()=>{
  const point={id:'t',project_key:'a',anchor_page:1,focus:'decision' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'choices',required_context_pages:[],optional_context_pages:[]};
  const evidence=['글자 배치','색상 대비','색상 대비'].map((quote,i)=>({id:'e'+i,project_key:'a',category:'decision',focus_target_id:'t',
    question_eligible:true,unknown_fields:[],anchors:[{page:1,region_id:'p1:r1',quote,visual_description:null}]})) as unknown as ResolvedEvidence[];
  let n=0;
  const request:Request=async <T>(kind:string,_schema:any,args:any):Promise<T>=>{
    if(kind==='QuestionSet')return {questions:n++?[]:evidence.map(e=>({evidence_id:e.id,anchor_indices:[1],angle:'decision'}))} as T;
    const rows=JSON.parse(args.prompt.split('\n').find((s:string)=>s.startsWith('[{'))!);
    return {reviews:rows.map((r:any)=>({question_id:r.question_id,status:'supported',reason:'fixture',region_support:true,
      no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:true}))} as T;
  };
  const result=await generateQuestions(evidence,request,{selectedPoints:[point],imagesFor:async()=>[]});
  assert.equal(result.cards.length,2);assert.ok(result.checks.some(c=>c.reasons.includes('repeated_source_angle')));
});
test('v0.7.1 numeric OCR cannot bypass quote checks by hiding inside a visual observation',()=>{
  const record={basis:'visual_observation',statement:'3 4 unified steps',anchors:[{quote:null,visual_description:'3 4 unified steps'}],details:[]} as any;
  assert.ok(localEvidenceChecks(record).includes('numeric_observation_requires_text_anchor'));
});
test('v0.8.1 visual artifact lists split without copying counts, inventing observations or discarding required context',()=>{
  const parent={category:'artifact',basis:'visual_observation',statement:'2개 컷',focus_target_id:'t1',
    anchors:['붉은 배경의 포스터','푸른 배경의 포스터'].map((visual_description,i)=>({page:1,region_key:'r'+(i+1),
      kind:'visual',purpose:'artifact',quote:null,visual_description,location:'fixture'})),
    details:[{field:'visible_structure',value:'2개 컷',anchor_indices:[1,2]}]} as any;
  const before=JSON.stringify(parent),pieces=atomicArtifacts(parent);assert.equal(pieces.length,2);
  for(const [i,p]of pieces.entries()){
    assert.deepEqual(p.anchors,[parent.anchors[i]]);assert.equal(p.statement,parent.anchors[i].visual_description);
    assert.deepEqual(p.details,[{field:'visible_structure',value:null,anchor_indices:[]}]);assert.deepEqual(localEvidenceChecks(p),[]);
  }
  assert.equal(JSON.stringify(parent),before);
  for(const changed of [{...parent,category:'alternative'},{...parent,basis:'portfolio_claim'},
    {...parent,anchors:[parent.anchors[0],{...parent.anchors[1],page:2}]},
    {...parent,anchors:[parent.anchors[0],{...parent.anchors[1],purpose:'context'}]}])assert.deepEqual(atomicArtifacts(changed),[changed]);
});
test('v0.8.1 source material is questioned in the chosen discipline without reauthoring its facts',()=>{
  const source={anchors:[{quote:"기존 '원'을 '환'으로 변경하였습니다",visual_description:null}]} as ResolvedEvidence;
  const plan={evidence_id:'e',anchor_indices:[1],angle:'decision' as const};
  const design=materializeQuestion(plan,source,'design'),marketing=materializeQuestion(plan,source,'marketing');
  assert.match(design.question,/시각적 구성이나 사용 흐름/);assert.match(marketing.question,/타깃·메시지·콘텐츠·채널/);
  assert.ok(design.question.startsWith('원문: '+source.anchors[0].quote+'\n'));
  assert.doesNotMatch(design.question,/화폐를 변경한 이유|직접 제작했|협업한/);
});
test('v0.8.2 decision aspects name distinct explanation tasks without repeating fallible visual prose',()=>{
  const source={anchors:[{region_id:'p1:r1',quote:null,visual_description:'제목과 휴대폰이 중앙에 있다'}]} as ResolvedEvidence;
  const base={evidence_id:'e',anchor_indices:[1],angle:'decision' as const};
  const style=materializeQuestion({...base,aspect:'visual_style'},source,'design');
  const hierarchy=materializeQuestion({...base,aspect:'information_hierarchy'},source,'design');
  assert.match(style.question,/색·형태·서체/);assert.match(hierarchy.question,/정보의 우선순위/);
  assert.doesNotMatch(style.question,/제목과 휴대폰이 중앙/);assert.notEqual(style.answer_target,hierarchy.answer_target);
  assert.ok(style.answer_target.startsWith('p1:r1:'));
  assert.equal(QuestionPlan.safeParse({...base,angle:'measurement',aspect:'visual_style'}).success,false);
  assert.equal(QuestionPlan.safeParse({...base,aspect:'visual_style'}).success,true);
});
test('v0.8.2 displayed source includes all selected quotes without joining metrics into a new claim',()=>{
  const source={anchors:[{region_id:'p7:r6',quote:'도달\n3,085',visual_description:null},
    {region_id:'p7:r1',quote:'MBTI 빙고 모음',visual_description:null}]} as ResolvedEvidence;
  const q=materializeQuestion({evidence_id:'e',anchor_indices:[1,2],angle:'measurement'},source,'marketing');
  assert.ok(q.question.startsWith('원문: 도달\n3,085\n원문: MBTI 빙고 모음\n'));
  assert.doesNotMatch(q.question,/MBTI로.*달성|인과|A\/B/);
});
test('v0.7.3 failed source-region review cannot be retried into acceptance',async()=>{
  const point={id:'t',project_key:'a',anchor_page:1,focus:'decision' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'fixture',required_context_pages:[],optional_context_pages:[]};
  const e={id:'e',project_key:'a',category:'decision',focus_target_id:'t',question_eligible:true,unknown_fields:[],
    anchors:[{page:1,region_id:'p1:r1',quote:'잘못 옮긴 원문',visual_description:null}]} as unknown as ResolvedEvidence;
  let reviews=0,round=0;
  const request:Request=async <T>(kind:string,_schema:any,args:any):Promise<T>=>{
    if(kind==='QuestionSet'){if(round++)assert.deepEqual(JSON.parse(args.prompt.split('\n').at(-1)),[]);
      return {questions:[{evidence_id:'e',anchor_indices:[1],angle:'decision'}]} as T;}
    reviews++;return {reviews:[{question_id:'candidate-1',status:'unsupported',reason:'source mismatch',region_support:false,
      no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:true}]} as T;
  };
  const result=await generateQuestions([e],request,{selectedPoints:[point],imagesFor:async()=>[]});
  assert.equal(result.cards.length,0);assert.equal(reviews,1);
  assert.ok(result.checks.some(c=>c.reasons.includes('previous_source_region_failure')));
});
test('v0.6 questions copy source numerals and cannot insert free-form role or experiment premises',()=>{
  for(const quote of ['3가지의 타입이 포함된 타입패밀리','개인 프로젝트','ROAS 목표 300%','From 2–3 min to ≤30sec for returning users']){
    const source={anchors:[{quote,visual_description:null}]} as ResolvedEvidence;
    const q=materializeQuestion({evidence_id:'e',anchor_indices:[1],angle:'measurement'},source);
    assert.ok(q.question.startsWith('원문: '+quote+'\n'));assert.match(q.question,/실제로 검증했다면/);
    assert.doesNotMatch(q.question,/혼자 진행|협업했|실험했|달성했|UI 디자인으로 발전/);
  }
});
test('v0.6 persistent KRW window includes concurrent reservations and cannot reset on reopen',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'portfolio-krw-')),'ledger');let b=new Budget(path);
  b.capAdditionalKrw(10,2000);const id=b.reserve('gemini-3.8-flash',1000,1000);
  assert.throws(()=>b.reserve('gemini-3.8-flash',1000,1000));b.settle(id,'gemini-3.8-flash',{promptTokenCount:1000,candidatesTokenCount:1000,totalTokenCount:2000});b.close();
  b=new Budget(path);try{b.capAdditionalKrw(10,2000);assert.ok(b.remaining<.001);assert.throws(()=>b.capAdditionalKrw(20,2000));
    assert.equal(b.snapshot().additional_estimated_krw,9);
  }finally{b.close();}
  const payload=buildPayload({kind:'scan',model:'gemini-3.8-flash',schema:DocumentMap,prompt:'scan',thinkingLevel:'LOW'});
  assert.deepEqual(payload.generationConfig.thinkingConfig,{thinkingLevel:'LOW'});
});
