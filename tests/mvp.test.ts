import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,rgb} from 'pdf-lib';
import {DocumentMap, type QuestionCard, type ResolvedEvidence} from '../src/schema.ts';
import {normalizeMap,validateMap,selectPages,analyzePdf} from '../src/pipeline.ts';
import {pageTiles,pageBox,openRenderer,renderPage} from '../src/pdf.ts';
import {questionQuality,generateQuestions,materializeQuestion,type Request} from '../src/questions.ts';
import {Budget,buildPayload} from '../src/gemini.ts';

test('v0.6 normalizes redundant context without hiding missing/cross-project references or project limits',()=>{
  const map=DocumentMap.parse({pages:Array.from({length:20},(_,i)=>({page:i+1,role:'project',readability:'readable',note:'work'})),
    projects:Array.from({length:20},(_,i)=>({key:'p'+i,title:'Work '+i,pages:[i+1]})),focus_targets:[{
      project_key:'p0',anchor_page:1,focus:'decision',specificity:'concrete_action',context_status:'located',reason:'core',
      required_context_pages:[1,1],optional_context_pages:[1],importance:'core',topic:'layout'}]});
  validateMap(normalizeMap(map),20);assert.deepEqual(map.focus_targets[0].required_context_pages,[]);
  map.focus_targets[0].required_context_pages=[2];assert.throws(()=>validateMap(normalizeMap(map),20),/프로젝트/);
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
  const quality=questionQuality(cards,['t1','t2']);assert.equal(quality.status,'needs_review');assert.deepEqual(quality.missing_focus_target_ids,['t2']);
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
  const result=await generateQuestions([evidence],request,{selectedPointIds:['t1'],imagesFor:async rows=>{
    assert.equal(rows[0].source.anchors.length,1);return [[rows[0].source.anchors[0].region_id,new Uint8Array()]];}});
  assert.equal(result.cards.length,0);assert.equal(rounds,2);assert.equal(seenImages,1);
  assert.ok(result.checks[0].reasons.includes('no_added_premise'));
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
