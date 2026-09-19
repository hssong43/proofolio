import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,rgb} from 'pdf-lib';
import {DocumentMap, QuestionPlan, QuestionDrafts, type QuestionCard, type ResolvedEvidence} from '../src/schema.ts';
import {normalizeMap,validateMap,validateAnchors,selectPages,analyzePdf,localEvidenceChecks,atomicArtifacts} from '../src/pipeline.ts';
import {pageTiles,pageBox,openRenderer,renderPage,alignRangeTypography,numericQuoteIssue,quoteTranscriptionIssue} from '../src/pdf.ts';
import {questionQuality,questionFocusErrors,generateQuestions,materializeQuestion,interviewGuide,questionErrors,type Request} from '../src/questions.ts';
import {Budget} from '../src/llm.ts';
import {buildOpenRouterPayload} from '../src/openrouter.ts';

const authored={question:'이 작업의 판단 기준을 설명해 주세요.',intent:'구체적인 판단 기준 확인',listen_for:['원문과 연결된 판단 기준']};

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
    if(kind==='QuestionSet'){rounds++;return {questions:rounds===1?[{...authored,evidence_id:'e1',anchor_indices:[1],angle:'decision'}]:[]} as T;}
    assert.equal(args.images[0][0],'p1:r1');seenImages++;
    return {reviews:[{question_id:'candidate-1',status:'supported',reason:'fixture',region_support:true,no_added_premise:false,
      distinct_answer:true,addresses_focus:true,substantive:true}]} as T;
  };
  const result=await generateQuestions([evidence],request,{contextImages:[],selectedPoints:[{id:'t1',project_key:'a',anchor_page:1,focus:'decision',specificity:'concrete_action',context_status:'located',reason:'fixture',required_context_pages:[],optional_context_pages:[]}],imagesFor:async rows=>{
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
test('v0.10.1 late numeric regions in a tall PDF remain in extraction transcription hints',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,2400]);
  for(let i=1;i<=48;i++)page.drawText(`Step ${i}`,{x:20,y:2400-i*48,size:8});
  page.drawText('Final time 2–3 min',{x:20,y:35,size:8});let extractionSeen=false;
  const result=await analyzePdf(await pdf.save(),{model:'gemini-test',track:'design',generate:async request=>{
    if(request.kind==='PageIndex')return {pages:request.images!.map((_,i)=>({page:i+1,role:'project',readability:'readable',note:'fixture',
      project_title:'A',heading:null,key_content:'fixture',continues_previous:false,referenced_pages:[]}))};
    if(request.kind==='DocumentMap')return {pages:[{page:1,role:'project',readability:'readable',note:'fixture'}],
      projects:[{key:'a',title:'A',pages:[1]}],focus_targets:[{project_key:'a',anchor_page:1,focus:'measurement',
        specificity:'concrete_action',context_status:'located',reason:'fixture',required_context_pages:[],optional_context_pages:[]}]};
    if(request.kind==='VisualInventory')return {coverage:'complete',limitations:[],links:[],regions:Array.from({length:8},(_,i)=>({
      key:`r${i+1}`,kind:'text_block',box:[0,0,1000,1000],description:`fixture region ${i+1}`,salient_text:null,
      identification:'clear',readability:'readable',source_role:'unknown',role_basis:null}))};
    assert.equal(request.kind,'DesignExtraction');extractionSeen=true;
    const inventory=JSON.parse(request.prompt.split('시각 영역 데이터: ')[1].split('\n필수 details: ')[0])[0];
    const hints=inventory.text_layer_quote_hints;
    assert.ok(hints.length>24,'numeric hints must not be clipped to early regions');
    assert.equal(hints.at(-1).region_key,inventory.regions.at(-1).key);
    assert.match(hints.at(-1).text,/Final time 2–3 min/);
    assert.ok(hints.every((h:{text:string})=>h.text.length<=1200));
    return {evidence:[]}; // Contract check only: no model quality or recovered evidence is claimed.
  }});
  assert.equal(extractionSeen,true);assert.equal(result.questions.length,0);
});
test('v0.10.3 range typography copies only a unique, in-region literal and keeps factual mismatches rejected',()=>{
  const box=[0,0,500,500],quote='From 2-3 min to ≤ 30 sec for returning users';
  const source='From 2–3 min to ≤ 30 sec for returning users',spans=[{box,text:source}];
  assert.equal(alignRangeTypography(quote,box,spans),source);
  assert.equal(quoteTranscriptionIssue(alignRangeTypography(quote,box,spans),box,spans),null);
  assert.equal(quoteTranscriptionIssue(quote,box,spans),'nonverbatim_symbol_transcription');
  for(const text of [source+' '+source,source+' '+quote,source.replace('2–3','22–3'),source.replace('2–3','2–30'),
    source.replace('2–3','2−3'),source.replace('2–3','2—3'),source.replace('30','40'),source.replace('≤','≥'),
    source.replace('returning','new')])assert.equal(alignRangeTypography(quote,box,[{box,text}]),quote);
  assert.equal(alignRangeTypography(quote,box,[]),quote);
  assert.equal(alignRangeTypography(quote,box,[{box:[700,700,900,900],text:source}]),quote);
  for(const [before,after]of [['CVR 2-3%','CVR 2–3%p'],['ROAS 2-3x','ROI 2–3x'],['① 범위 2-3일','1 범위 2–3일']])
    assert.equal(alignRangeTypography(before,box,[{box,text:after}]),before);
  for(const text of ['+2–3','2–3%','2–3x','22–3','2–30'])assert.equal(alignRangeTypography('2-3',box,[{box,text}]),'2-3');
  assert.equal(alignRangeTypography('🔋 충전 2-3분',box,[{box,text:'🔋 충전 2–3분'}]),'🔋 충전 2–3분');
  assert.equal(alignRangeTypography('3-4 unified steps (first-time)',box,[{box,text:'3–4 unified steps (first‑time)'}]),'3–4 unified steps (first‑time)');
  assert.equal(alignRangeTypography('3-4 unified steps (first-time)',box,[{box,text:'3–4 unified steps (first—time)'}]),'3-4 unified steps (first-time)');
});
test('v0.10.4 numeric boundaries cannot discard spaced signs or units, even in an exact substring',()=>{
  const box=[0,0,500,500];
  for(const [quote,text]of [['CVR 2–3%','CVR 2–3% p'],['CVR 2–3%','CVR 2–3%p'],
    ['2–3','- 2–3'],['2–3','≤ 2–3'],['2–3','2–3 %'],['2–3','2–3 x'],
    ['2–3','22–3'],['2–3','2–30'],['ROAS 3','ROAS 3.5x']]){
    const spans=[{box,text}],rough=quote.replaceAll('–','-');
    assert.equal(alignRangeTypography(rough,box,spans),rough,text);
    assert.equal(numericQuoteIssue(quote,box,spans),'numeric_text_layer_mismatch',text);
    assert.notEqual(quoteTranscriptionIssue(alignRangeTypography(rough,box,spans),box,spans),null,text);
  }
  for(const text of ['CVR 2–3% p','- 2–3','2–3 %','2–3 x','ROAS 3.5x','ROAS 3.5x performance'])
    assert.equal(numericQuoteIssue(text,box,[{box,text}]),null,text);
  assert.equal(numericQuoteIssue('CVR 2–3%',box,[{box,text:'CVR 2–3% performance is a claim.'}]),null);
  assert.equal(numericQuoteIssue('CVR 2–3%',box,[{box,text:'CVR 2–3% p; CVR 2–3%.'}]),null,'a complete exact occurrence may exist');
  assert.equal(numericQuoteIssue('CVR 2–3%',box,[]),null,'missing text layer is not negative evidence');
});
test('v0.10.3 full extraction records literal alignment but still requires visual source review',async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([400,300]);
  const original='From 2-3 min to 30 sec',exact='From 2–3 min to 30 sec';
  page.drawText(exact,{x:20,y:180,size:12});let reviewed=false;
  const raw={focus_target_id:'t1',category:'validation',basis:'portfolio_claim',statement:original,
    anchors:[{page:1,region_key:'r1',location:'fixture',kind:'text',purpose:'claim',quote:original,visual_description:null}],
    details:['method','sample_and_period','result','limitation'].map(field=>({field,value:field==='result'?original:null,anchor_indices:field==='result'?[1]:[]}))};
  const result=await analyzePdf(await pdf.save(),{model:'gemini-test',track:'design',generate:async request=>{
    if(request.kind==='DocumentMap')return {pages:[{page:1,role:'project',readability:'readable',note:'fixture'}],
      projects:[{key:'a',title:'A',pages:[1]}],focus_targets:[{project_key:'a',anchor_page:1,focus:'measurement',
        specificity:'concrete_action',context_status:'located',reason:'fixture',required_context_pages:[],optional_context_pages:[]}]};
    if(request.kind==='VisualInventory')return {coverage:'complete',limitations:[],links:[],regions:[{key:'r1',kind:'text_block',box:[0,0,1000,1000],
      description:'fixture',salient_text:null,identification:'clear',readability:'readable',source_role:'unknown',role_basis:null}]};
    if(request.kind==='DesignExtraction')return {evidence:[raw]};
    assert.equal(request.kind,'Reviews');reviewed=true;
    const [candidate]=JSON.parse(request.prompt.split('근거 후보 데이터:\n')[1]);
    assert.equal(candidate.anchors[0].quote,exact);assert.equal(candidate.statement,exact);
    assert.equal(candidate.details.find((d:{field:string})=>d.field==='result').value,exact);
    return {reviews:[{evidence_id:candidate.evidence_id,status:'unsupported',reason:'fixture: image contradicts text layer',
      document_support:{status:'not_assessed',reason:'fixture',anchor_indices:[]}}]};
  }});
  assert.equal(reviewed,true);assert.equal(raw.anchors[0].quote,original);
  assert.equal(result.evidence[0].question_eligible,false);assert.equal(result.questions.length,0);
  assert.ok(result.evidence[0].local_checks.includes('text_layer_range_alignment:anchor=1'));
});
test('v0.8.3 omitted source delimiters require source evidence; original unclosed captions and inequalities stay unchanged',()=>{
  const box=[0,0,1000,1000],clipped="<네이버에 '대학 학생회' 검색시 최상단 노출글 작성";
  for(const [quote,close] of [[clipped,'>'],['[캠페인 제안',']'],['(개인 프로젝트',')'],['《제안서','》'],['「소재 선택','」']]){
    assert.equal(quoteTranscriptionIssue(quote,box,[{box,text:quote+close}]),'omitted_source_delimiter');
    assert.equal(quoteTranscriptionIssue(quote,box,[{box,text:quote}]),null);
    assert.equal(quoteTranscriptionIssue(quote,box,[]),null);
  }
  for(const quote of [clipped+'>','[캠페인 제안]','(개인 프로젝트)','< 30 sec','<= 30 sec','≤ 30 sec','ROAS < 300%'])
    assert.equal(quoteTranscriptionIssue(quote,box,[]),null);
  assert.equal(quoteTranscriptionIssue('ROAS 300%',box,[{box,text:'ROAS +300%'}]),'numeric_text_layer_mismatch');
  assert.equal(clipped.endsWith('>'),false);
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
test('v0.8.5 title checks ignore parenthesis layout spaces but never infer ambiguous ownership',()=>{
  const map=DocumentMap.parse({pages:[1,2,3].map(page=>({page,role:'project',readability:'readable',note:'work'})),
    projects:[{key:'channel',title:'뜨거운 20대(4인 팀작업)',pages:[1]},{key:'council',title:'학생회',pages:[2,3]}],focus_targets:[]});
  const index=[{page:2,role:'project' as const,readability:'readable' as const,note:'work',project_title:'뜨거운 20대 (4인 팀작업)',
    heading:'뜨거운 20대( 4인 팀작업 )',key_content:'work',continues_previous:false,referenced_pages:[]}];
  assert.throws(()=>validateMap(map,3,index),/indexed_project_title_conflict: page=2, project=channel/);
  assert.doesNotThrow(()=>validateMap(map,3,[{...index[0],project_title:'뜨거운20대(4인 팀작업)',heading:'뜨거운20대(4인 팀작업)'}]));
  map.projects[0].pages.push(2);map.projects[1].pages=[3];assert.doesNotThrow(()=>validateMap(map,3,index));
  map.projects[0].pages=[1];map.projects[1].pages=[2,3];map.projects[1].title='뜨거운 20대 (4인 팀작업)';
  assert.doesNotThrow(()=>validateMap(map,3,index));
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
test('v0.11 focus IDs and angle tags do not prove coverage, required source pages remain mandatory',()=>{
  const point={id:'t1',project_key:'a',anchor_page:1,focus:'measurement' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'measurement',required_context_pages:[2],optional_context_pages:[]};
  const source={focus_target_id:'t1',anchors:[{page:1}]} as ResolvedEvidence;
  const plan={...authored,evidence_id:'e',anchor_indices:[1],angle:'problem' as const};
  assert.deepEqual(questionFocusErrors(plan,source,point),['question_missing_required_context']);
  source.anchors.push({page:2} as any);
  assert.deepEqual(questionFocusErrors({...plan,angle:'measurement'},source,point),[]);
  source.category='creative';
  assert.deepEqual(questionFocusErrors({...plan,angle:'decision'},source,point),[]);
  source.category='objective';
  assert.deepEqual(questionFocusErrors(plan,source,point),[],'angle is a label; source-based semantic review judges focus');
  const cards=[{id:'q1',focus_target_id:'t1',angle:'measurement',anchors:[{region_id:'p1:r1',quote:'지표'}]}] as QuestionCard[];
  assert.deepEqual(questionQuality(cards,['t1']).missing_focus_target_ids,['t1']);
  cards[0].focus_check={matches:true,method:'fixture',reason:'fixture'};
  assert.deepEqual(questionQuality(cards,['t1']).missing_focus_target_ids,['t1']);
  assert.deepEqual(questionQuality(cards,['t1'],[{focus_target_id:'t1',checks:[{aspect:'측정 조건',source_requirements:[{region_id:'p1:r1',quote:'지표'}],question_ids:['q1']}]}]).missing_focus_target_ids,[]);
});
test('v0.9 three grounded questions cannot hide an uncovered part of a selected point',()=>{
  const sources=['message','PoAS','CAC','activation'].map((quote,i)=>({region_id:'p1:r'+(i+1),quote}));
  const cards=['t1','t2','t3'].map((focus_target_id,i)=>({id:'q'+(i+1),focus_target_id,angle:'measurement',anchors:[sources[i]],
    focus_check:{matches:true,method:'fixture',reason:'partial relevance'}})) as QuestionCard[];
  const coverage=[{focus_target_id:'t1',checks:[{aspect:'message',source_requirements:[sources[0]],question_ids:['q1']}]},
    {focus_target_id:'t2',checks:[{aspect:'PoAS',source_requirements:[sources[1]],question_ids:['q2']}]},
    {focus_target_id:'t3',checks:[{aspect:'CAC conditions',source_requirements:[sources[2]],question_ids:['q3']},
      {aspect:'activation conditions',source_requirements:[sources[3]],question_ids:[]}]}];
  const partial=questionQuality(cards,['t1','t2','t3'],coverage);
  assert.equal(partial.status,'needs_review');assert.deepEqual(partial.missing_focus_target_ids,['t3']);
  assert.deepEqual(partial.coverage[2].missing_aspects,['activation conditions']);
  coverage[2].checks[1].question_ids=['q1','invented'];
  assert.deepEqual(questionQuality(cards,['t1','t2','t3'],coverage).missing_focus_target_ids,['t3']);
  cards.push({...cards[2],id:'q4',anchors:[sources[3]] as QuestionCard['anchors']});coverage[2].checks[1].question_ids=['q4'];
  assert.equal(questionQuality(cards,['t1','t2','t3'],coverage).status,'ready');
});
test('v0.10 a shared region does not cover an unquoted metric, all required sources must be asked',()=>{
  const cards=[{id:'q1',focus_target_id:'t',angle:'measurement',focus_check:{matches:true,method:'fixture',reason:'fixture'},
    anchors:[{region_id:'p1:r1',quote:'CVR improved +28%',visual_description:null}]},
    {id:'q2',focus_target_id:'t',angle:'decision',focus_check:{matches:true,method:'fixture',reason:'fixture'},
      anchors:[{region_id:'p1:r2',quote:null,visual_description:'두 대안의 화면 배치'}]}] as QuestionCard[];
  const cvr={region_id:'p1:r1',quote:'CVR improved +28%'},repeat={region_id:'p1:r1',quote:'23% more repeat purchases'};
  const assessment=[{focus_target_id:'t',checks:[{aspect:'지표별 조건',source_requirements:[cvr,repeat],question_ids:['q1']}]}];
  const missing=questionQuality(cards,['t'],assessment).coverage[0].checks[0];
  assert.equal(missing.complete,false);assert.deepEqual(missing.missing_source_requirements,[repeat]);
  assessment[0].checks[0].source_requirements=[{region_id:'p2:r1',quote:cvr.quote}];
  assert.deepEqual(questionQuality(cards,['t'],assessment).coverage[0].checks[0].question_ids,[]);
  assessment[0].checks[0].source_requirements=[];
  assert.equal(questionQuality(cards,['t'],assessment).coverage[0].complete,false);
  assessment[0].checks[0].source_requirements=[cvr,repeat];
  cards.push({...cards[0],id:'q3',anchors:[{...cards[0].anchors[0],quote:repeat.quote}]});
  assessment[0].checks[0].question_ids.push('q3');
  assert.equal(questionQuality(cards,['t'],assessment).status,'ready');
  const visual=[{focus_target_id:'t',checks:[{aspect:'배치',source_requirements:[{region_id:'p1:r2',quote:null}],question_ids:['q2']}]}];
  assert.equal(questionQuality(cards,['t'],visual).coverage[0].complete,true);
  visual[0].checks[0].source_requirements[0].region_id='p1:r1';visual[0].checks[0].question_ids=['q1'];
  assert.equal(questionQuality(cards,['t'],visual).coverage[0].complete,false);
  const clipped=[{focus_target_id:'t',checks:[{aspect:'단위 보존',source_requirements:[{region_id:'p1:r1',quote:'CVR improved +28%'}],question_ids:['q1']}]}];
  cards[0].anchors[0].quote='CVR improved +28%p';
  assert.equal(questionQuality(cards,['t'],clipped).coverage[0].complete,false,'a prefix cannot drop a unit suffix');
});
test('v0.9.1 second question round excludes prior review IDs and cannot shrink the fixed coverage checklist',async()=>{
  for(const mode of ['fixed','missing','rewritten','changed_source']){
  const points=['a','b','c'].map(id=>({id,project_key:'project',anchor_page:1,focus:'measurement' as const,
    specificity:'concrete_action' as const,context_status:'located' as const,reason:'fixture',required_context_pages:[],optional_context_pages:[]}));
  const evidence=['retargeting','PoAS','CAC','activation'].map((quote,i)=>({id:'e'+i,project_key:'project',category:'metric',
    focus_target_id:points[Math.min(i,2)].id,question_eligible:true,unknown_fields:[],anchors:[{page:1,region_id:'p1:r'+(i+1),quote,visual_description:null}]})) as unknown as ResolvedEvidence[];
  let rounds=0,reviewRounds=0;
  const request:Request=async(kind,schema,args,check)=>{
    let raw:unknown;
    if(kind==='QuestionSet'){
      if(rounds){assert.match(args.prompt,/"missing_focus_target_ids":\["c"\]/);
        assert.match(args.prompt,/"missing_verified_sources":\[\{"focus_target_id":"c","source_requirements":\[\{"region_id":"p1:r4","quote":"activation"\}\]/);}
      raw={questions:(rounds++?[evidence[3]]:evidence.slice(0,3)).map(e=>({...authored,evidence_id:e.id,anchor_indices:[1],angle:'measurement'}))};
    }else{
      const rows=JSON.parse(args.prompt.split('\n').find(s=>s.startsWith('[{'))!);reviewRounds++;
      const first=reviewRounds===1,prefix=first?'candidate-':'q';
      raw={reviews:rows.map((r:any)=>({question_id:r.question_id,status:'supported',reason:'fixture',region_support:true,
        no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:true})),focus_coverage:[
        {focus_target_id:'a',checks:[{aspect:'message',source_requirements:[{region_id:'p1:r1',quote:'retargeting'}],question_ids:[prefix+'1']}]},
        {focus_target_id:'b',checks:[{aspect:'PoAS',source_requirements:[{region_id:'p1:r2',quote:'PoAS'}],question_ids:[prefix+'2']}]},
        {focus_target_id:'c',checks:[{aspect:'CAC',source_requirements:[{region_id:'p1:r3',quote:'CAC'}],question_ids:[prefix+'3']},
          {aspect:'activation',source_requirements:[{region_id:'p1:r4',quote:'activation'}],question_ids:first?[]:['candidate-4']}]}]};
      if(!first){
        assert.match(args.prompt,/"aspect":"activation","source_requirements":\[\{"region_id":"p1:r4","quote":"activation"\}\]/);
        const priorReview=structuredClone(raw) as any;priorReview.reviews[0].question_id='q1';
        assert.equal(schema.safeParse(priorReview).success,false,'prior q IDs are invalid even before cross-reference validation');
        const coverage=(raw as any).focus_coverage[2].checks;
        if(mode==='missing')coverage.pop();
        if(mode==='rewritten')coverage[1].aspect='CAC again';
        if(mode==='changed_source')coverage[1].source_requirements=[{region_id:'p1:r3',quote:'CAC'}];
      }
    }
    const parsed=schema.parse(raw);check?.(parsed);return parsed;
  };
  const generation=generateQuestions(evidence,request,{contextImages:[],selectedPoints:points,imagesFor:async rows=>{
    if(rounds===2)assert.deepEqual(rows.map(r=>r.question_id),['q1','q2','q3','candidate-4']);return [];
  }});
  if(mode!=='fixed'){await assert.rejects(generation,/고정된 핵심 항목/);continue;}
  const result=await generation;
  assert.equal(rounds,2);assert.equal(result.cards.length,4);
  assert.equal(questionQuality(result.cards,points.map(p=>p.id),result.focusCoverage).status,'ready');
  assert.deepEqual(result.focusCoverage[2].checks[1].question_ids,['q4']);
  assert.match(result.cards[3].question,/원문: activation/);
  }
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
    if(kind==='QuestionSet')return {questions:n++?[]:evidence.map(e=>({...authored,evidence_id:e.id,anchor_indices:[1],angle:'decision'}))} as T;
    const rows=JSON.parse(args.prompt.split('\n').find((s:string)=>s.startsWith('[{'))!);
    return {reviews:rows.map((r:any)=>({question_id:r.question_id,status:'supported',reason:'fixture',region_support:true,
      no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:true}))} as T;
  };
  const result=await generateQuestions(evidence,request,{contextImages:[],selectedPoints:[point],imagesFor:async()=>[]});
  assert.equal(result.cards.length,2);assert.ok(result.checks.some(c=>c.reasons.includes('repeated_source_angle')));
});
test('v0.7.1 numeric OCR cannot bypass quote checks by hiding inside a visual observation',()=>{
  const record={basis:'visual_observation',statement:'3 4 unified steps',anchors:[{quote:null,visual_description:'3 4 unified steps'}],details:[]} as any;
  assert.ok(localEvidenceChecks(record).includes('numeric_observation_requires_text_anchor'));
});
test('v0.11 identical authored questions reach semantic review for distinct regions, not repeated sources',async()=>{
  const point={id:'t',project_key:'a',anchor_page:1,focus:'decision' as const,specificity:'artifact_only' as const,
    context_status:'located' as const,reason:'choices',required_context_pages:[],optional_context_pages:[]};
  const evidence=['p1:r1','p1:r2','p1:r1'].map((region_id,i)=>({id:'e'+i,project_key:'a',category:'artifact',focus_target_id:'t',
    question_eligible:true,unknown_fields:[],anchors:[{page:1,region_id,quote:null,visual_description:'색 대비가 있는 포스터'}]})) as unknown as ResolvedEvidence[];
  let rounds=0,reviewed=0;
  const request:Request=async <T>(kind:string,_schema:any,args:any):Promise<T>=>{
    if(kind==='QuestionSet')return {questions:rounds++?[]:evidence.map(e=>({...authored,evidence_id:e.id,anchor_indices:[1],angle:'decision',aspect:'visual_style'}))} as T;
    const rows=JSON.parse(args.prompt.split('\n').find((s:string)=>s.startsWith('[{'))!);reviewed+=rows.length;
    return {reviews:rows.map((r:any)=>({question_id:r.question_id,status:'supported',reason:'different source works',region_support:true,
      no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:true}))} as T;
  };
  const result=await generateQuestions(evidence,request,{track:'design',contextImages:[],selectedPoints:[point],imagesFor:async()=>[]});
  assert.equal(reviewed,2);assert.equal(result.cards.length,2);
  assert.equal(result.cards[0].question,result.cards[1].question);
  assert.notEqual(result.cards[0].anchors[0].region_id,result.cards[1].anchors[0].region_id);
  assert.ok(result.checks.find(c=>c.evidence_id==='e2')?.reasons.includes('duplicate_question'));
  const guide=interviewGuide({analysis_plan:{selected_pages:[1]},questions:result.cards,rejected_candidates:[],question_checks:result.checks});
  assert.match(guide,/연결 영역: p1:r1/);assert.match(guide,/연결 영역: p1:r2/);
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
test('v0.11 authored questions and intent are preserved, never replaced with a category template',()=>{
  const source={anchors:[{region_id:'p1:r1',quote:'표를 카드 형태로 변경',visual_description:null}]} as ResolvedEvidence;
  const plan={...authored,evidence_id:'e',anchor_indices:[1],angle:'decision' as const,
    question:'표와 카드에서 항목을 비교하는 방식은 어떻게 달라지나요?',intent:'정보 비교 방식의 차이'};
  const q=materializeQuestion(plan,source);
  assert.equal(q.question,'원문: 표를 카드 형태로 변경\n'+plan.question);
  assert.equal(q.intent,plan.intent);assert.deepEqual(q.listen_for,plan.listen_for);
  assert.equal(q.answer_target,'p1:r1: '+plan.intent);
});
test('v0.11 no inferred visual caption is silently inserted into authored question text',()=>{
  const source={anchors:[{region_id:'p1:r1',quote:null,visual_description:'제목과 휴대폰이 중앙에 있다'}]} as ResolvedEvidence;
  const plan={...authored,evidence_id:'e',anchor_indices:[1],angle:'decision' as const,aspect:'visual_style' as const,
    question:'제목과 본문의 크기 차이가 정보 우선순위에 어떤 영향을 주나요?'};
  const q=materializeQuestion(plan,source);
  assert.ok(q.question.endsWith(plan.question));assert.doesNotMatch(q.question,/휴대폰이 중앙/);
  assert.equal(QuestionPlan.safeParse({...plan,question:undefined,intent:undefined,listen_for:undefined}).success,false);
});
test('v0.11 all selected source quotes stay verbatim outside the authored prose',()=>{
  const source={anchors:[{region_id:'p7:r6',quote:'도달\n3,085',visual_description:null},
    {region_id:'p7:r1',quote:'MBTI 빙고 모음',visual_description:null}]} as ResolvedEvidence;
  const plan={...authored,evidence_id:'e',anchor_indices:[1,2],angle:'measurement' as const,
    question:'도달 지표를 해석할 때 중복 이용자는 어떻게 집계되었나요?'};
  const q=materializeQuestion(plan,source);
  assert.equal(q.question,'원문: 도달\n3,085\n원문: MBTI 빙고 모음\n'+plan.question);
});
test('v0.11 schema requires bounded authored prose and has no neutral-template fallback',()=>{
  const valid={...authored,evidence_id:'e',anchor_indices:[1],angle:'decision'};
  assert.equal(QuestionDrafts.safeParse({questions:[valid]}).success,true);
  assert.equal(QuestionDrafts.safeParse({questions:[{...valid,angle:'process',aspect:'message'}]}).success,true);
  assert.equal(QuestionDrafts.safeParse({questions:[{...valid,anchor_indices:[1,1]}]}).success,false);
  for(const change of [{question:undefined},{question:''},{question:'a'.repeat(501)},{intent:undefined},{listen_for:[]}]){
    assert.equal(QuestionDrafts.safeParse({questions:[{...valid,...change}]}).success,false);
  }
});
test('v0.11 free-form numeric premises are checked even when intent sounds cautious',()=>{
  const source={question_eligible:true,anchors:[{quote:'ROAS 목표 300%'}]} as ResolvedEvidence;
  const q={...authored,evidence_id:'e',question:'ROAS 300%p 달성 비결은 무엇인가요?'};
  assert.ok(questionErrors(q,source,new Set(),new Set()).includes('numeric_premise_requires_source_quote'));
  assert.ok(questionErrors({...q,question:'어떻게 판단했나요?',intent:'ROI 300% 달성 확인'},source,new Set(),new Set()).length);
});
test('v0.7.3 failed source-region review cannot be retried into acceptance',async()=>{
  const point={id:'t',project_key:'a',anchor_page:1,focus:'decision' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'fixture',required_context_pages:[],optional_context_pages:[]};
  const e={id:'e',project_key:'a',category:'decision',focus_target_id:'t',question_eligible:true,unknown_fields:[],
    anchors:[{page:1,region_id:'p1:r1',quote:'잘못 옮긴 원문',visual_description:null}]} as unknown as ResolvedEvidence;
  let reviews=0,round=0;
  const request:Request=async <T>(kind:string,_schema:any,args:any):Promise<T>=>{
    if(kind==='QuestionSet'){if(round++)assert.deepEqual(JSON.parse(args.prompt.split('\n').at(-1)),[]);
      return {questions:[{...authored,evidence_id:'e',anchor_indices:[1],angle:'decision'}]} as T;}
    reviews++;return {reviews:[{question_id:'candidate-1',status:'unsupported',reason:'source mismatch',region_support:false,
      no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:true}]} as T;
  };
  const result=await generateQuestions([e],request,{contextImages:[],selectedPoints:[point],imagesFor:async()=>[]});
  assert.equal(result.cards.length,0);assert.equal(reviews,1);
  assert.ok(result.checks.some(c=>c.reasons.includes('previous_source_region_failure')));
});
test('v0.10.4 rejected question tasks cannot win a second vote by reordering anchors or changing evidence IDs',async()=>{
  const point={id:'t',project_key:'a',anchor_page:1,focus:'decision' as const,specificity:'concrete_action' as const,
    context_status:'located' as const,reason:'fixture',required_context_pages:[],optional_context_pages:[]};
  for(const mode of ['same','reordered','alias','new_aspect','new_source']){
    const e={id:'e',project_key:'a',category:'decision',focus_target_id:'t',question_eligible:true,unknown_fields:[],
      anchors:['title','sitemap description','actual navigation'].map((quote,i)=>({page:1,region_id:'p1:r'+(i+1),quote,visual_description:null}))} as unknown as ResolvedEvidence;
    let round=0,reviews=0;
    const request:Request=async(kind,schema,args,check)=>{
      let raw:unknown;
      if(kind==='QuestionSet'){
        const second=round++>0;
        raw={questions:[{...authored,evidence_id:second&&mode==='alias'?'alias':'e',
          anchor_indices:second&&mode==='reordered'?[2,1]:second&&mode==='new_source'?[1,3]:[1,2],
          angle:'decision',aspect:second&&mode==='new_aspect'?'flow':'information_hierarchy'}]};
      }else{
        const rows=JSON.parse(args.prompt.split('\n').find(s=>s.startsWith('[{'))!),second=reviews++>0;
        raw={reviews:rows.map((r:any)=>({question_id:r.question_id,status:second?'supported':'unsupported',reason:'fixture',
          region_support:true,no_added_premise:true,distinct_answer:true,addresses_focus:second,substantive:true})),
          focus_coverage:[{focus_target_id:'t',checks:[{aspect:'navigation decision',
            source_requirements:[{region_id:'p1:r1',quote:'title'}],question_ids:rows.map((r:any)=>r.question_id)}]}]};
      }
      const parsed=schema.parse(raw);check?.(parsed);return parsed;
    };
    const result=await generateQuestions([e,{...e,id:'alias'}],request,{contextImages:[],selectedPoints:[point],imagesFor:async()=>[]});
    const revised=mode==='new_aspect'||mode==='new_source';
    assert.equal(reviews,revised?2:1,mode);assert.equal(result.cards.length,revised?1:0,mode);
    assert.equal(result.checks.some(c=>c.reasons.includes('previous_question_task_failure')),!revised,mode);
  }
});
test('v0.11 source numerals are not rewritten by question assembly',()=>{
  for(const quote of ['3가지의 타입이 포함된 타입패밀리','개인 프로젝트','ROAS 목표 300%','From 2–3 min to ≤30sec for returning users']){
    const source={anchors:[{quote,visual_description:null}]} as ResolvedEvidence;
    const q=materializeQuestion({...authored,evidence_id:'e',anchor_indices:[1],angle:'measurement'},source);
    assert.ok(q.question.startsWith('원문: '+quote+'\n'));assert.ok(q.question.endsWith(authored.question));
  }
});
test('v0.6 persistent KRW window includes concurrent reservations and cannot reset on reopen',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'portfolio-krw-')),'ledger');let b=new Budget(path);
  b.capAdditionalKrw(10,2000);const id=b.reserve('gemini-3.8-flash',1000,1000);
  assert.throws(()=>b.reserve('gemini-3.8-flash',1000,1000));b.settle(id,'gemini-3.8-flash',{promptTokenCount:1000,candidatesTokenCount:1000,totalTokenCount:2000});b.close();
  b=new Budget(path);try{b.capAdditionalKrw(10,2000);assert.ok(b.remaining<.001);assert.throws(()=>b.capAdditionalKrw(20,2000));
    assert.equal(b.snapshot().additional_estimated_krw,9);
  }finally{b.close();}
  const payload=buildOpenRouterPayload({kind:'Scan',model:'google/gemini-3.8-flash',schema:DocumentMap,prompt:'scan',thinkingLevel:'LOW'});
  assert.deepEqual(payload.reasoning,{effort:'low',exclude:true});
});
