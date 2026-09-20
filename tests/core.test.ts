import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,PDFName,rgb,degrees,StandardFonts} from 'pdf-lib';
import {loadImage,createCanvas} from '@napi-rs/canvas';
import {analyzePdf,validateMap,selectPages,validateReviews,validateExtraction,extractionDetailRegions,localEvidenceChecks} from '../src/pipeline.ts';
import * as S from '../src/schema.ts';
import {readPdf,slicePdf,openRenderer,renderPage,renderPng,savePreviews,textSpans,quoteLocationCheck,textCropTouchesEdge} from '../src/pdf.ts';
import {SchemaValidationError} from '../src/llm.ts';
import type {Generate,ModelRequest} from '../src/llm.ts';
import {runCli,loadEnv} from '../src/cli.ts';
import {questionErrors} from '../src/questions.ts';

export async function pdfBytes(count=3){const pdf=await PDFDocument.create();for(let i=0;i<count;i++)pdf.addPage([200+i,300]);return pdf.save({addDefaultPage:false});}
export const point=(project_key:string,anchor_page:number,focus:S.FocusTarget['focus'],changes:Partial<S.FocusTarget>={})=>({project_key,anchor_page,focus,
  specificity:focus==='artifact'?'artifact_only' as const:'concrete_action' as const,context_status:'located' as const,reason:'구체적 작업 설명',required_context_pages:[],optional_context_pages:[],...changes});
export const mapped=():S.DocumentMap=>({pages:[{page:1,role:'cover',readability:'readable',note:'표지'},
  {page:2,role:'project',readability:'readable',note:'A'},{page:3,role:'project',readability:'readable',note:'B'}],
  projects:[{key:'a',title:'A',pages:[2]},{key:'b',title:'B',pages:[3]}],focus_targets:[point('a',2,'contribution'),point('b',3,'artifact')]});
export const anchor=():S.Anchor=>({page:1,region_key:'r1',location:'오른쪽 설명',kind:'text',purpose:'claim',quote:'디자인 담당',visual_description:null});
export const inventory=():S.VisualInventory=>({coverage:'complete',limitations:[],links:[],regions:[{key:'r1',kind:'text_block',box:[0,0,1000,1000],
  description:'설명 영역',salient_text:'디자인 담당',identification:'clear',readability:'readable',source_role:'unknown',role_basis:null}]});
export const details=(track:S.Track,category:string)=>Object.entries(track==='design'?S.DESIGN_FIELDS:S.MARKETING_FIELDS)
  .find(([key])=>key===category)![1].map((field:string)=>({field,value:null as string|null,anchor_indices:[] as number[]}));
export function item(track:S.Track):S.Evidence {
  if(track==='marketing')return {focus_target_id:null,statement:'ROAS 목표 300%',basis:'portfolio_claim',category:'metric',
    anchors:[{...anchor(),quote:'ROAS 목표 300%'}],details:details(track,'metric'),metric:{name:'ROAS',reported_value:'300%',result_type:'target',
      baseline:null,period:null,denominator:null,data_source:null,attribution_method:null},
    metric_sources:{name:[1],reported_value:[1],result_type:[1],baseline:[],period:[],denominator:[],data_source:[],attribution_method:[]}};
  const d=details('design','contribution');d[0]={field:'own_scope',value:'디자인 담당',anchor_indices:[1]};
  return {focus_target_id:null,statement:'디자인 담당',basis:'portfolio_claim',category:'contribution',anchors:[anchor()],details:d};
}
export function fake(track:S.Track,options:{map?:S.DocumentMap;statuses?:S.Review['status'][];transform?:(request:ModelRequest,raw:any)=>unknown}={}){
  const calls:ModelRequest[]=[];let reviewIndex=0;const extracted:S.Evidence[]=[];
  const generate:Generate=async request=>{calls.push(request);let raw:any;
    if(request.kind==='DocumentMap')raw=structuredClone(options.map??mapped());
    else if(request.kind==='VisualInventory')raw=inventory();
    else if(request.kind.endsWith('Extraction')){const e=item(track),context=JSON.parse(request.prompt.split('대상 프로젝트 데이터: ')[1].split('\n')[0]);
      if(context.focus_targets_local_pages[0]){e.focus_target_id=context.focus_targets_local_pages[0].id;e.anchors[0].page=context.focus_targets_local_pages[0].anchor_page;}
      raw={evidence:[e]};
    }else if(request.kind==='CropReadings')raw={regions:request.images!.map(([id])=>{
      const anchors=extracted.flatMap(e=>e.anchors).filter(a=>`p${a.page}:${a.region_key}`===id);
      return {region_id:id,text:anchors.flatMap(a=>a.quote?[a.quote]:[]).join('\n')||null,
        observations:anchors.flatMap(a=>a.visual_description?[a.visual_description]:[]),readability:'readable',limitations:[]};
    })};
    else if(request.kind==='Reviews'){const candidates=JSON.parse(request.prompt.split('근거 후보 데이터:\n')[1].split('\n')[0]);
      const status=(options.statuses??['supported','unsupported'])[reviewIndex++]??'supported';raw={reviews:candidates.map((e:any)=>({
        evidence_id:e.evidence_id,status,reason:'가짜 계약 응답; 시각 품질 평가가 아님',anchor_checks:e.anchors.map((a:any,i:number)=>({anchor_index:i+1,status,reason:'fixture',reading_excerpt:a.quote??a.visual_description})),document_support:{status:status==='supported'?'needs_explanation':'not_assessed',reason:'추가 설명',anchor_indices:[]}}))};
    }else if(request.kind==='QuestionSet'){const source=JSON.parse(request.prompt.split('근거 데이터:\n')[1].split('\n')[0])[0];raw={questions:[{evidence_id:source.id,
      anchor_indices:[1],angle:'ownership',question:'이 자료에 참여했다면 담당한 범위를 설명해 주세요.',intent:'자료와 참여 관계 확인',listen_for:['이 자료에 참여했다면 담당한 범위를 설명해 주세요.']}]};
      if(['claude-opus-5','anthropic/claude-opus-5'].includes(request.model)){assert.equal(request.images,undefined);assert.match(request.prompt,/JSON만 제공/);}
      else assert.ok(request.images?.length,'Gemini question writer receives original context images');
    }else if(request.kind==='QuestionReviews'){const rows=JSON.parse(request.prompt.split('\n').find(s=>s.startsWith('[{'))!);
      const targets=JSON.parse(request.prompt.split('선정 포인트 가설: ')[1].split('\n')[0]);
      raw={reviews:rows.map((r:any)=>({question_id:r.question_id,status:'supported',reason:'가짜 전제 검사',region_support:true,no_added_premise:true,distinct_answer:true,addresses_focus:true,substantive:false,
        field_checks:[{field:'question',index:null},{field:'intent',index:null},...r.listen_for.map((_:unknown,i:number)=>({field:'listen_for',index:i+1}))].map(c=>({...c,status:'supported',reason:'fixture',premise_checks:[],
          field_text:c.field==='listen_for'?r.listen_for[c.index!-1]:r[c.field],
          experience_check:{basis:'observed',condition:null,anchor_index:null,source_excerpt:null}}))})),
        focus_coverage:targets.map((p:any)=>({focus_target_id:p.id,checks:[{aspect:'가짜 계약 검사',
          source_requirements:rows.filter((r:any)=>r.selected_target_hypothesis?.id===p.id).flatMap((r:any)=>r.source.anchors.map((a:any)=>({region_id:a.region_id,quote:a.quote}))).slice(0,1),
          question_ids:rows.filter((r:any)=>r.selected_target_hypothesis?.id===p.id).map((r:any)=>r.question_id)}]}))};}
    else throw new Error('Unknown fake request');
    const result:any=options.transform?options.transform(request,raw):raw;
    if(request.kind.endsWith('Extraction')){extracted.length=0;extracted.push(...result.evidence);
      const context=JSON.parse(request.prompt.split('대상 프로젝트 데이터: ')[1].split('\n')[0]);
      result.point_checks??=context.focus_targets_local_pages.map((p:{id:string})=>{const indices=result.evidence.flatMap((e:S.Evidence,i:number)=>e.focus_target_id===p.id?[i+1]:[]);
        return {focus_target_id:p.id,status:indices.length?'extracted':'no_relevant_source',evidence_indices:indices,reason:'synthetic fixture; not model quality'};});
    }
    return result;
  };return {generate,calls};
}
const run=async(track:S.Track='design',options:Parameters<typeof fake>[1]={},overrides:Partial<Parameters<typeof analyzePdf>[1]>={})=>{
  const f=fake(track,options);return {result:await analyzePdf(await pdfBytes(options.map?.pages.length??3),{track,model:'gemini-test',generate:f.generate,...overrides}),calls:f.calls};};

test('v0.17 extraction accounts for every point without inventing evidence for empty or unreadable work',()=>{
  const points=[{...point('a',1,'decision'),id:'t1'},{...point('a',2,'artifact'),id:'t2'}];
  const row={evidence:[{...item('design'),focus_target_id:'t1'}],point_checks:[
    {focus_target_id:'t1',status:'extracted' as const,evidence_indices:[1],reason:'fixture'},
    {focus_target_id:'t2',status:'unreadable' as const,evidence_indices:[],reason:'crop unreadable'}]};
  assert.doesNotThrow(()=>validateExtraction(row,points));
  assert.throws(()=>validateExtraction({...row,point_checks:undefined},points),/ID/);
  for(const change of [{focus_target_id:'wrong'},{evidence_indices:[1]},{status:'extracted' as const}])
    assert.throws(()=>validateExtraction({...row,point_checks:[row.point_checks[0],{...row.point_checks[1],...change}]},points));
  assert.throws(()=>validateExtraction({...row,point_checks:[row.point_checks[0],row.point_checks[0]]},points),/ID/);
  const requires=[{...points[0],required_context_pages:[3]},points[1]];
  assert.throws(()=>validateExtraction(row,requires),/required_context_pages=3/);
  const linked=structuredClone(row);linked.evidence[0].anchors.push({...anchor(),page:3,purpose:'context'});
  assert.doesNotThrow(()=>validateExtraction(linked,requires));
});
test('v0.17 extraction detail images are bounded original crops, including partial-text artwork',()=>{
  const inv=inventory(),base=inv.regions[0];inv.regions=[
    {...base,key:'r1',kind:'text_block'}, {...base,key:'r2',kind:'ad_creative',readability:'partial',box:[0,0,100,100]},
    {...base,key:'r3',kind:'chart',box:[100,100,300,300]}, {...base,key:'r4',kind:'photograph',box:[0,0,800,800]},
    {...base,key:'r5',kind:'ui_screen',identification:'uncertain'}];
  const original=structuredClone(inv),points=[{...point('a',7,'measurement'),id:'t1'}];
  const rows=extractionDetailRegions(points,new Map([[7,inv],[8,inventory()]]));
  assert.deepEqual(rows.map(r=>[r.page,r.region.key]),[[7,'r3'],[7,'r4']]);assert.deepEqual(inv,original);
  const partial=extractionDetailRegions(points,new Map([[7,{...inv,regions:[inv.regions[1]]}]]));
  assert.equal(partial[0].region.readability,'partial');assert.deepEqual(partial[0].region.box,[0,0,100,100]);
});
test('v0.17.1 flat text crops with boundary ink are deferred without moving their boxes',async()=>{
  const canvas=createCanvas(120,50),ctx=canvas.getContext('2d');
  ctx.fillStyle='#dedede';ctx.fillRect(0,0,120,50);ctx.fillStyle='black';ctx.fillRect(10,10,80,15);
  assert.equal(await textCropTouchesEdge(canvas.toBuffer('image/png')),false);
  ctx.fillRect(118,10,2,12);assert.equal(await textCropTouchesEdge(canvas.toBuffer('image/png')),true);
  ctx.fillStyle='#101010';ctx.fillRect(0,0,120,50);ctx.fillStyle='white';ctx.fillRect(0,10,10,15);
  assert.equal(await textCropTouchesEdge(canvas.toBuffer('image/png')),true);
  ctx.fillStyle='red';ctx.fillRect(0,0,4,4);
  assert.equal(await textCropTouchesEdge(canvas.toBuffer('image/png')),false,'nonuniform corners are outside this heuristic, not certified clean');
});

test('parallel skim preserves the first API error after later queued calls fail and sends no new work',async()=>{
  const first=new Error('HTTP 404: original routing failure');let calls=0,finished=0;
  await assert.rejects(analyzePdf(await pdfBytes(26),{track:'design',model:'gemini-test',generate:async r=>{
    assert.equal(r.kind,'PageIndex');const index=calls++;
    await new Promise(resolve=>setTimeout(resolve,index===0?5:25));finished++;
    throw index===0?first:new Error('session already halted');
  }}),e=>e===first);
  assert.equal(calls,3);assert.equal(finished,3);
});

test('01 separate tracks and original-page provenance',async()=>{for(const track of ['design','marketing'] as const){const {result:r,calls}=await run(track);
  assert.equal(calls.length,12);assert.deepEqual(r.evidence.map(e=>e.anchors[0].page),[2,3]);assert.equal(r.questions[0].anchors[0].region_id,'p2:r1');
  assert.equal(r.evidence[1].question_eligible,false);assert.equal(r.evidence[0].verification_scope,'presence_in_pdf_only');
  const extracted=calls.filter(c=>c.kind.endsWith('Extraction'));assert.ok(extracted.every(c=>c.thinkingLevel==='MEDIUM'));
  assert.deepEqual(await Promise.all(extracted.map(async c=>(await readPdf(c.pdf!)).getPage(0).getWidth())),[201,202]);}});
test('v0.12 Opus writes only evidence-based questions; Gemini still reviews the exact source crops',async()=>{
  let first=true;
  const {result,calls}=await run('design',{transform:(q,r)=>{if(q.kind==='QuestionSet'&&first){first=false;throw new SchemaValidationError('fixture');}return r;}},
    {model:'google/gemini-3.1-pro-preview',skimModel:'google/gemini-3.8-flash',reviewModel:'google/gemini-3.1-pro-preview',questionModel:'anthropic/claude-opus-5'});
  assert.equal(result.question_model,'anthropic/claude-opus-5');assert.equal(result.question_provider,'openrouter');
  assert.equal(result.question_input,'verified_evidence_only');assert.equal(result.questions.length,1);
  for(const c of calls){
    if(c.kind==='QuestionSet'){assert.equal(c.model,'anthropic/claude-opus-5');assert.equal(c.pdf,undefined);assert.equal(c.images,undefined);}
    else if(c.kind==='DocumentMap')assert.equal(c.model,'google/gemini-3.8-flash');
    else assert.equal(c.model,'google/gemini-3.1-pro-preview');
    if(c.kind==='QuestionReviews')assert.ok(c.images?.length);
  }
  assert.ok(result.metrics.stages.some(s=>s.stage==='QuestionSet'&&s.attempt===2));
  assert.equal(result.questions[0].anchors[0].page,2);
});
test('02 missing duplicate unknown review IDs fail after one retry',async()=>{for(const mode of ['missing','duplicate','unknown'])await assert.rejects(run('design',{transform:(q,r)=>{
  if(q.kind==='Reviews'){if(mode==='missing')r.reviews=[];else if(mode==='duplicate')r.reviews.push(r.reviews[0]);else r.reviews[0].evidence_id='invented';}return r;}}),/ID/);});
test('OpenRouter routes Gemini vision and Opus evidence-only questions through the unchanged provenance checks',async()=>{
  const {result,calls}=await run('design',{}, {provider:'openrouter',model:'google/gemini-3.1-pro-preview',
    skimModel:'google/gemini-3.8-flash',reviewModel:'google/gemini-3.1-pro-preview',questionModel:'anthropic/claude-opus-5'});
  assert.equal(result.vision_provider,'openrouter');assert.equal(result.question_provider,'openrouter');
  assert.equal(result.question_input,'verified_evidence_only');assert.equal(result.questions[0].anchors[0].page,2);
  for(const c of calls){
    if(c.kind==='QuestionSet'){assert.equal(c.model,'anthropic/claude-opus-5');assert.equal(c.images,undefined);assert.equal(c.pdf,undefined);}
    else if(c.kind==='DocumentMap')assert.equal(c.model,'google/gemini-3.8-flash');
    else{assert.equal(c.model,'google/gemini-3.1-pro-preview');if(c.kind==='QuestionReviews')assert.ok(c.images?.length);}
  }
  await assert.rejects(run('design',{}, {provider:'openrouter',model:'anthropic/claude-opus-5'}),/질문 생성/);
});
test('v0.9 focus coverage IDs and question ownership fail after one bounded retry',async()=>{
  for(const mode of ['missing','duplicate','unknown_point','unknown_question','other_point']){
    let reviews=0;
    await assert.rejects(run('design',{transform:(q,r)=>{
      if(q.kind==='QuestionReviews'){
        reviews++;
        if(mode==='missing')r.focus_coverage=[];
        else if(mode==='duplicate')r.focus_coverage.push(r.focus_coverage[0]);
        else if(mode==='unknown_point')r.focus_coverage[0].focus_target_id='invented';
        else if(mode==='unknown_question')r.focus_coverage[0].checks[0].question_ids=['invented'];
        else r.focus_coverage[1].checks[0].question_ids=[r.reviews[0].question_id];
      }return r;
    }}),/핵심 포인트/);
    assert.equal(reviews,2);
  }
});
test('v0.10 coverage cannot invent a source or use a null quote as a text wildcard',async()=>{
  for(const mode of ['region','quote','null','substring']){
    let reviews=0;
    await assert.rejects(run('design',{transform:(q,r)=>{
      if(q.kind==='QuestionReviews'){
        reviews++;const source=r.focus_coverage[0].checks[0].source_requirements[0];
        if(mode==='region')source.region_id='p99:r1';else source.quote=mode==='quote'?'없는 성과':mode==='substring'?'디자인':null;
      }return r;
    }}),/검증 출처/);
    assert.equal(reviews,2);
  }
});
test('03 uncertain unreadable sources cannot make questions',async()=>{const m=mapped();m.pages[1].readability='unreadable';const {result}=await run('design',{map:m,statuses:['uncertain']});assert.equal(result.status,'insufficient_evidence');assert.equal(result.questions.length,0);});
test('04 invalid maps and cross-project anchors fail',async()=>{for(const mutation of [(m:S.DocumentMap)=>m.pages.pop(),(m:S.DocumentMap)=>m.projects[0].pages.push(1),
  (m:S.DocumentMap)=>m.projects[1].key='a',(m:S.DocumentMap)=>m.projects.pop()]){const m=mapped();mutation(m);assert.throws(()=>validateMap(m,3));}
  const {result}=await run('design',{transform:(q,r)=>{if(q.kind.endsWith('Extraction'))r.evidence[0].anchors[0].page=3;return r;}});assert.equal(result.questions.length,0);assert.equal(result.rejected_candidates.length,2);});
test('05 PDF preflight and slicing order',async()=>{for(const bytes of [Buffer.from('not pdf'),Buffer.from('%PDF-broken'),await pdfBytes(0),await pdfBytes(61)])await assert.rejects(readPdf(bytes));
  const encrypted=await PDFDocument.create();encrypted.addPage();encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:PDFName.of('Standard')}));
  await assert.rejects(readPdf(await encrypted.save()),/암호화/);
  const p=await readPdf(await slicePdf(await readPdf(await pdfBytes()),[3,1]));assert.deepEqual(p.getPages().map(p=>p.getWidth()),[202,200]);await assert.rejects(slicePdf(p,[1,1]));});
test('06 empty document and extraction remain insufficient',async()=>{const m=mapped();m.projects=[];m.focus_targets=[];m.pages.forEach(p=>p.role='other');assert.equal((await run('design',{map:m})).result.status,'insufficient_evidence');
  assert.equal((await run('design',{transform:(q,r)=>q.kind.endsWith('Extraction')?{evidence:[]}:r})).result.questions.length,0);});
test('07 domain and anchor contracts strict',()=>{for(const changes of [{quote:null},{page:true},{page:0},{quote:'  '},{kind:'visual',visual_description:'화면'}])assert.equal(S.Anchor.safeParse({...anchor(),...changes}).success,false);
  assert.equal(S.DesignEvidence.safeParse({...item('design'),basis:'visual_observation'}).success,false);
  assert.equal(S.DesignEvidence.safeParse(item('marketing')).success,false);assert.equal(S.MarketingEvidence.safeParse({...item('marketing'),metric:null}).success,false);
  const e=item('design');e.details[0].anchor_indices=[2];assert.equal(S.DesignEvidence.safeParse(e).success,false);});
test('08 regions and inspection mode',async()=>{for(const box of [[0,0,0,1000],[0,0,1001,1000],[0,0,500],[0,true,500,500]])assert.equal(S.Region.safeParse({...inventory().regions[0],box}).success,false);
  assert.equal(S.VisualInventory.safeParse({...inventory(),links:[{from_key:'r1',to_key:'r2',relation:'caption_for',basis:'캡션'}]}).success,false);
  const {result,calls}=await run('design',{}, {inspectOnly:true});assert.equal(calls.length,3);assert.equal(result.status,'visual_inspection_only');});
test('09 unknown and uncertain regions cannot pass',async()=>{for(const mode of ['unknown','uncertain']){const {result}=await run('design',{statuses:['supported','supported'],transform:(q,r)=>{
  if(mode==='uncertain'&&q.kind==='VisualInventory')r.regions[0].identification='uncertain';if(mode==='unknown'&&q.kind.endsWith('Extraction'))r.evidence[0].anchors[0].region_key='r99';return r;}});assert.equal(result.questions.length,0);}});
test('10 actual crops rotation CropBox text coordinates and previews',async()=>{const pdf=await PDFDocument.create(),page=pdf.addPage([200,300]);
  page.drawRectangle({x:0,y:150,width:100,height:150,color:rgb(1,0,0)});page.drawRectangle({x:100,y:150,width:100,height:150,color:rgb(0,1,0)});
  const inspect=async(b:Uint8Array,box:number[])=>{const r=await openRenderer(b);try{const c=await renderPage(r,1,box);return [...c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data];}finally{await r.loadingTask.destroy();}};
  assert.deepEqual(await inspect(await pdf.save(),[0,0,500,500]),[255,0,0,255]);page.setRotation(degrees(90));assert.deepEqual(await inspect(await pdf.save(),[0,500,500,1000]),[255,0,0,255]);
  page.setRotation(degrees(180));assert.deepEqual(await inspect(await pdf.save(),[500,500,1000,1000]),[255,0,0,255]);
  page.setRotation(degrees(270));assert.deepEqual(await inspect(await pdf.save(),[500,0,1000,500]),[255,0,0,255]);
  page.setRotation(degrees(0));page.setCropBox(0,150,100,150);assert.deepEqual(await inspect(await pdf.save(),[0,0,1000,1000]),[255,0,0,255]);
  const dir=await mkdtemp(join(tmpdir(),'portfolio-render-'));await savePreviews(await pdf.save(),[{page:1,...inventory()}],join(dir,'preview'));
  await assert.rejects(savePreviews(await pdf.save(),[],join(dir,'preview')));assert.ok((await stat(join(dir,'preview/page-001.png'))).size>0);
  await assert.rejects(renderPng(await pdf.save(),1,[500,0,0,500]));
  const text=await PDFDocument.create(),tp=text.addPage([200,300]);tp.drawText('ROAS target 300%',{x:15,y:230,size:12,font:await text.embedFont(StandardFonts.Helvetica)});
  const r=await openRenderer(await text.save());try{const spans=await textSpans(r,1);assert.equal(quoteLocationCheck('ROAS target 300%',[0,0,400,1000],spans),'matched');
    assert.equal(quoteLocationCheck('ROAS target 300%',[800,0,1000,1000],spans),'outside_region');}finally{await r.loadingTask.destroy();}});
test('11 focused caps full selection and ordered progress',async()=>{const events:any[]=[];const {result,calls}=await run('design',{}, {pageBudget:1,skimModel:'gemini-skim',onEvent:e=>events.push(e)});
  assert.equal(result.analysis_plan.selected_pages.length,1);assert.equal(calls[0].model,'gemini-skim');assert.ok(calls.slice(1).every(c=>c.model==='gemini-test'));
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));assert.equal(events.at(-1).type,'complete');assert.equal(result.metrics.model_calls,calls.length);
  assert.deepEqual(selectPages(mapped(),'full',1).selected_pages,[2,3]);const m=mapped();m.focus_targets=[];assert.deepEqual(selectPages(m,'focused',2).selected_pages,[2,3]);});
test('12 context bundles atomic optional pages cannot starve points',()=>{const m:S.DocumentMap={pages:Array.from({length:9},(_,i)=>({page:i+1,role:'project',readability:'readable',note:'작업'})),
  projects:[{key:'a',title:'A',pages:[1,2,3,4]},{key:'b',title:'B',pages:[5,6,7]},{key:'c',title:'C',pages:[8,9]}],focus_targets:[
    point('a',2,'decision',{required_context_pages:[1],optional_context_pages:[3,4]}),point('b',6,'contribution',{required_context_pages:[5]}),
    point('a',3,'process',{required_context_pages:[1]}),point('c',8,'decision',{required_context_pages:[9]})]};
  validateMap(m,9);const p=selectPages(m,'focused',5);assert.deepEqual(p.selected_pages,[1,2,3,5,6]);assert.equal(p.covered_axes.length,3);assert.deepEqual(selectPages(m,'focused',1).selected_pages,[]);
  m.focus_targets[0].context_status='unresolved';assert.ok(selectPages(m).deferred_points.some(p=>p.defer_reason==='unresolved_context'));});
test('13 point references and shared pages do not add projects',async()=>{const {result}=await run('design',{transform:(q,r)=>{if(q.kind.endsWith('Extraction'))r.evidence[0].focus_target_id='invented';return r;}});assert.equal(result.questions.length,0);
  const m=mapped();m.projects[1].pages=[2,3];m.focus_targets[1]=point('b',2,'artifact',{required_context_pages:[3]});assert.deepEqual((await run('design',{map:m},{pageBudget:1})).result.analysis_plan.selected_project_keys,['a']);});
test('14 a bad candidate does not remove a valid sibling',async()=>{const {result}=await run('design',{transform:(q,r)=>{if(q.kind.endsWith('Extraction'))r.evidence.push({...structuredClone(r.evidence[0]),focus_target_id:'invented'});return r;}});
  assert.equal(result.evidence.length,2);assert.equal(result.rejected_candidates.length,2);assert.equal(result.questions.length,1);});
test('15 support checks separate presence and proof, batch size four',async()=>{const {result,calls}=await run('design',{statuses:['supported','supported','supported','supported'],transform:(q,r)=>{
  if(q.kind==='VisualInventory')r.regions.push({...r.regions[0],key:'r9',box:[500,0,1000,1000],description:'다른 설명 영역'});
  if(q.kind.endsWith('Extraction')){r.evidence[0].anchors[0].region_key='r2';r.evidence=Array.from({length:5},()=>structuredClone(r.evidence[0]));}return r;}});
  assert.equal(result.evidence.length,10);assert.equal(calls.filter(c=>c.kind==='Reviews').length,4);
  for(const call of calls.filter(c=>c.kind==='Reviews'))for(const record of JSON.parse(call.prompt.split('근거 후보 데이터:\n')[1])){
    assert.equal(record.anchors[0].anchor_index,1);assert.equal(record.anchors[0].region_key,'r2');}
  const e=item('design');for(const status of ['documented','conflicting'] as const)assert.throws(()=>validateReviews([e],[{evidence_id:'e',status:'supported',reason:'검사',anchor_checks:[{anchor_index:1,status:'supported',reason:'fixture'}],document_support:{status,reason:'검사',anchor_indices:[1]}}],['e']));});
test('16 unknown duplicate empty question candidates are excluded (v0.5 contract)',async()=>{for(const mode of ['unknown','duplicate','empty']){const {result}=await run('design',{transform:(q,r)=>{
  if(q.kind==='QuestionSet'){if(mode==='unknown')r.questions[0].evidence_id='invented';if(mode==='duplicate')r.questions.push(r.questions[0]);if(mode==='empty')r.questions=[];}return r;}});
  assert.equal(result.questions.length,mode==='duplicate'?1:0);if(mode!=='empty')assert.ok(result.question_checks.some(c=>c.status==='rejected'));}});
test('19 CLI events guide exclusive writes and environment precedence',async()=>{const {result}=await run();const dir=await mkdtemp(join(tmpdir(),'portfolio-cli-')),pdf=join(dir,'in.pdf'),output=join(dir,'result.json'),guide=join(dir,'questions.txt');
  await writeFile(pdf,await pdfBytes());const envPath=join(dir,'.env');await writeFile(envPath,'export OPENROUTER_API_KEY="key=123" # comment\nOPENROUTER_MODEL=gemini-env\nUNRELATED=ignored\n');
  const stdout:string[]=[],stderr:string[]=[];let calls=0;
  const args=[pdf,'--track','design','--model','google/gemini-3.1-pro-preview','--max-cost-usd','10','--events','--output',output,'--guide-output',guide,'--budget-ledger',join(dir,'budget.jsonl')];
  const deps={envPath,env:{OPENROUTER_API_KEY:'sk-or-existing-0000000000000000'},stdout:(s:string)=>stdout.push(s),stderr:(s:string)=>stderr.push(s),analyze:async(_b:Uint8Array,options:Parameters<typeof analyzePdf>[1])=>{
    calls++;assert.equal(options.apiKey,'sk-or-existing-0000000000000000');assert.equal(options.model,'google/gemini-3.1-pro-preview');options.onEvent?.({sequence:1,type:'complete',elapsed_ms:1,data:result});return result;}};
  assert.equal(await runCli(args,deps),0);assert.equal(stdout.length,1);assert.match(await readFile(guide,'utf8'),/페이지 2/);assert.equal((await stat(output)).mode&0o777,0o600);
  assert.equal(await runCli(args,deps),1);assert.equal(calls,1);});
test('26 env allowlist quoting and existing variable precedence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'portfolio-env-')),envPath=join(dir,'.env');
  await writeFile(envPath,'export OPENROUTER_API_KEY="key=123" # comment\nOPENROUTER_MODEL=gemini-env\nUNRELATED=ignored\n');
  const env:NodeJS.ProcessEnv={};loadEnv(envPath,env);assert.equal(env.OPENROUTER_API_KEY,'key=123');assert.equal(env.OPENROUTER_MODEL,'gemini-env');assert.equal(env.UNRELATED,undefined);
  env.OPENROUTER_API_KEY='existing';loadEnv(envPath,env);assert.equal(env.OPENROUTER_API_KEY,'existing');
  await writeFile(envPath,"OPENROUTER_API_KEY='do-not-print\n");assert.throws(()=>loadEnv(envPath,{}),e=>!String(e).includes('do-not-print'));});
test('23 only schema failures retry once and failure events never complete',async()=>{const original=fake('design'),events:any[]=[];let attempts=0;
  const result=await analyzePdf(await pdfBytes(),{track:'design',model:'gemini-test',generate:async r=>{if(attempts++===0)throw new SchemaValidationError('schema');return original.generate(r);}});
  assert.equal(result.metrics.model_calls,original.calls.length+1);
  for(const error of [new SchemaValidationError('again'),new Error('HTTP 429')]){let calls=0;await assert.rejects(analyzePdf(await pdfBytes(),{track:'design',model:'gemini-test',onEvent:e=>events.push(e),generate:async()=>{calls++;throw error;}}));assert.equal(calls,error instanceof SchemaValidationError?2:1);}
  assert.ok(events.every(e=>e.type!=='complete'));});
test('24 review rules get the same single bounded retry',async()=>{let n=0;const {result}=await run('design',{statuses:['supported','supported','unsupported'],transform:(q,r)=>{
  if(q.kind==='Reviews'&&n++===0)r.reviews[0].document_support={status:'conflicting',reason:'bad',anchor_indices:[1]};return r;}});assert.equal(result.metrics.model_calls,13);});
test('claim-only support is conservatively downgraded without weakening source checks',async()=>{
  const {result,calls}=await run('design',{statuses:['supported','supported'],transform:(q,r)=>{
    if(q.kind==='Reviews')for(const review of r.reviews)review.document_support={status:'documented',reason:'overstated claim',anchor_indices:[1]};return r;
  }});
  assert.equal(calls.filter(c=>c.kind==='Reviews').length,2,'no paid retry to restate an obvious evidence boundary');
  for(const e of result.evidence){assert.equal(e.question_eligible,true);assert.equal(e.document_support.status,'needs_explanation');
    assert.match(e.document_support.reason,/claim_only_support_downgraded/);assert.equal(e.source_check.status,'supported');}
  assert.ok(calls.filter(c=>c.kind==='VisualInventory').every(c=>c.thinkingLevel==='HIGH'));
});
test('claim-only downgrade cannot repair invalid references or unsupported source status',async()=>{
  for(const invalid of ['reference','source'])await assert.rejects(run('design',{statuses:['supported','supported'],transform:(q,r)=>{
    if(q.kind==='Reviews'){r.reviews[0].document_support={status:'documented',reason:'invalid',anchor_indices:[invalid==='reference'?99:1]};
      if(invalid==='source')r.reviews[0].status='unsupported';}return r;
  }}),SchemaValidationError);
});
test('25 artifact usage cannot infer collaboration',()=>{const e={...item('design'),category:'artifact',basis:'visual_observation',details:details('design','artifact'),anchors:[{...anchor(),quote:'Application 활용'}]};
  e.details[3]={field:'stated_usage',value:'Application 활용',anchor_indices:[1]};assert.equal(S.DesignEvidence.safeParse(e).success,true);
  e.details[3].value='Application 활용 (아티스트 협업 프로젝트)';assert.equal(S.DesignEvidence.safeParse(e).success,false);});
test('regression: numeral subject target actual percentage-point and ROI substitution',()=>{const d=item('design');d.category='decision';d.details=details('design','decision');d.anchors[0].quote='3가지의 타입이 포함된 타입패밀리';d.statement='3개 타입패밀리';assert.ok(localEvidenceChecks(d).includes('claim_statement_not_verbatim'));
  for(const change of [{reported_value:'300%p'},{name:'ROI'},{result_type:'reported_actual'}]){const m=item('marketing') as S.Evidence&{metric:zMetric};Object.assign(m.metric,change);assert.ok(localEvidenceChecks(m).length>0);}
  const q={evidence_id:'e',question:'전환율 300%p를 달성한 방법은?',intent:'확인',listen_for:['실적']};assert.ok(questionErrors(q,undefined,new Set()).includes('numeric_premise_requires_source_quote'));});
type zMetric={name:string;reported_value:string;result_type:string};
test('regression: source summaries and skim hypotheses are not question inputs',async()=>{
  const map=mapped();map.focus_targets[0].topic='UNVERIFIED_SCAN_HYPOTHESIS';
  const {calls}=await run('design',{map});const writing=calls.filter(c=>c.kind==='QuestionSet');
  const data=JSON.parse(writing[0].prompt.split('근거 데이터:\n')[1]);
  assert.ok(data.every((e:any)=>!('statement'in e)&&!('source_check'in e)&&!('question_focus'in e)));
  assert.ok(writing.every(c=>!c.prompt.includes('UNVERIFIED_SCAN_HYPOTHESIS')));
  assert.equal(data[0].focus_intent,'contribution');
  assert.ok(calls.some(c=>c.kind==='QuestionReviews'&&c.prompt.includes('UNVERIFIED_SCAN_HYPOTHESIS')),'original topic still governs coverage, not writer facts');
});
test('regression: unsupported semantic question review excludes final question',async()=>{const {result}=await run('design',{transform:(q,r)=>{if(q.kind==='QuestionReviews')r.reviews[0].status='unsupported';return r;}});assert.equal(result.questions.length,0);assert.equal(result.status,'insufficient_evidence');assert.ok(result.quality.coverage.every(c=>!c.complete));});

test('v0.14 linked crops only; missing, uncertain or body-outside-title anchors cannot pass',async()=>{
  for(const mode of ['missing','uncertain','unsupported']){
    const {result,calls}=await run('design',{transform:(q,r)=>{
      if(q.kind==='Reviews'){
        assert.equal(q.pdf,undefined);assert.equal(q.images,undefined);assert.match(q.prompt,/독립 판독 데이터/);
        r.reviews[0].anchor_checks=mode==='missing'?[]:[{anchor_index:1,status:mode,reason:'설명문은 제목 크롭 밖에 있음'}];
      }return r;
    }});
    assert.equal(result.questions.length,0);assert.ok(result.evidence.every(e=>!e.question_eligible));
    assert.equal(calls.some(c=>c.kind==='QuestionSet'),false);
  }
  const {result}=await run();
  assert.equal(result.schema_version,'0.17');assert.equal(result.max_questions,10);
  assert.ok(result.evidence[0].local_checks.includes('text_layer:unavailable'));
  assert.equal(result.evidence[0].question_eligible,true,'missing text layer is not absent image text');
});
test('v0.16 crop reading is blind, cached per region, and prior visual descriptions are never source facts',async()=>{
  const {result,calls}=await run('design',{statuses:['supported','supported'],transform:(q,r)=>{
    if(q.kind==='DesignExtraction'){
      const e=r.evidence[0];e.category='artifact';e.basis='visual_observation';e.statement='카드 밖 화분 옆에 놓인 전단지';
      e.details=details('design','artifact');e.anchors[0]={...e.anchors[0],kind:'visual',purpose:'artifact',quote:null,visual_description:e.statement};
    }
    if(q.kind==='CropReadings'){
      assert.ok(q.images?.length);assert.equal(q.pdf,undefined);
      assert.doesNotMatch(q.prompt,/화분|전단지|focus_target_id|statement|visual_description/);
      for(const c of r.regions){c.text=null;c.observations=['초록 테두리와 가운데 제목이 있는 카드'];}
    }
    if(q.kind==='Reviews')for(const e of r.reviews)for(const c of e.anchor_checks)c.reading_excerpt='초록 테두리와 가운데 제목이 있는 카드';
    return r;
  }});
  // Even an over-permissive comparison cannot leak its old object description to the writer.
  assert.ok(result.evidence.every(e=>e.anchors[0].visual_description==='초록 테두리와 가운데 제목이 있는 카드'));
  assert.doesNotMatch(calls.find(c=>c.kind==='QuestionSet')!.prompt,/화분|전단지/);
  assert.equal(calls.filter(c=>c.kind==='CropReadings').length,2);
});
test('v0.16 source approval needs its own independent crop excerpt, not another region or a missing reading',async()=>{
  for(const mode of ['missing_excerpt','wrong_text','unreadable','wrong_region']){
    const {result}=await run('design',{statuses:['supported','supported'],transform:(q,r)=>{
      if(q.kind==='CropReadings')for(const c of r.regions){
        if(mode==='wrong_text')c.text='프로젝트 제목';
        if(mode==='unreadable')c.readability='unreadable';
      }
      if(q.kind==='Reviews')for(const e of r.reviews)for(const c of e.anchor_checks){
        if(mode==='missing_excerpt')delete c.reading_excerpt;
        if(mode==='wrong_region')c.reading_excerpt='별도 문단 설명';
      }
      return r;
    }});
    assert.ok(result.evidence.every(e=>!e.question_eligible),mode);assert.equal(result.questions.length,0,mode);
  }
});
test('v0.17.1 source comparison aligns layout whitespace only and never rewrites stored quotes',async()=>{
  const {result,calls}=await run('design',{statuses:['supported','supported'],transform:(q,r)=>{
    if(q.kind==='CropReadings')for(const c of r.regions)c.text=c.text?.replace('디자인 담당','디자인\n담당');
    return r;
  }});
  assert.ok(result.evidence.every(e=>e.question_eligible));
  assert.ok(result.evidence.every(e=>e.anchors[0].quote==='디자인 담당'));
  const candidates=JSON.parse(calls.find(c=>c.kind==='Reviews')!.prompt.split('근거 후보 데이터:\n')[1]);
  assert.equal(candidates[0].anchors[0].quote,'디자인\n담당');
  assert.equal(candidates[0].details[0].value,'디자인\n담당');
  assert.equal(result.evidence[0].source_check.anchor_checks![0].reading_excerpt,'디자인\n담당');
});
test('v0.16 crop IDs fail closed after one format retry',async()=>{
  for(const mode of ['missing','duplicate','unknown'])await assert.rejects(run('design',{transform:(q,r)=>{
    if(q.kind==='CropReadings'){
      if(mode==='missing')r.regions=[];
      if(mode==='duplicate')r.regions.push(r.regions[0]);
      if(mode==='unknown')r.regions[0].region_id='p99:r99';
    }return r;
  }}),/독립 판독|출력 필드/);
});
test('v0.14 each card field must pass, even if the global reviewer approves',async()=>{
  for(const mode of ['missing','intent','listen_for']){
    const {result}=await run('design',{transform:(q,r)=>{
      if(q.kind==='QuestionReviews'){
        if(mode==='missing')r.reviews[0].field_checks.pop();
        else r.reviews[0].field_checks.find((c:any)=>c.field===mode).status='unsupported';
      }return r;
    }});
    assert.equal(result.questions.length,0);
    assert.ok(result.question_checks.some(c=>c.reasons.some(r=>/field_checks|field_premise/.test(r))));
  }
});
test('v0.14 metric fields match only their own linked quotes and cannot clip percent-point units',()=>{
  const m=S.MarketingEvidence.parse(item('marketing'));
  m.anchors.push({...anchor(),quote:'출처 설문조사',purpose:'context'});
  m.metric!.data_source='설문조사';m.metric_sources!.data_source=[1];
  assert.ok(localEvidenceChecks(m).includes('metric_not_verbatim:data_source'));
  m.metric_sources!.data_source=[2];assert.deepEqual(localEvidenceChecks(m),[]);
  m.anchors[0].quote='ROAS 목표 300%p';m.statement=m.anchors[0].quote;
  assert.ok(localEvidenceChecks(m).includes('metric_not_verbatim:reported_value'));
  m.metric_sources!.name=[3];assert.equal(S.MarketingEvidence.safeParse(m).success,false);
});
test('v0.15 standalone dashboard counts survive without relaxing units, signs, ranges or denominators',()=>{
  const m=S.MarketingEvidence.parse(item('marketing'));
  const set=(quote:string,value='1,250')=>{m.anchors[0].quote=quote;m.statement=quote;
    Object.assign(m.metric!,{name:'도달한 계정',reported_value:value,result_type:'reported_actual'});};
  set('최근 한 달\n1,250\n도달한 계정');assert.deepEqual(localEvidenceChecks(m),[]);
  for(const [quote,value] of [['1,250%\n도달한 계정','1,250'],['-\n1,250\n도달한 계정','1,250'],
    ['1,250\n%\n도달한 계정','1,250'],['1,250개\n도달한 계정','1,250'],['1,250–2,500\n도달한 계정','1,250']]){
    set(quote,value);assert.ok(localEvidenceChecks(m).includes('metric_not_verbatim:reported_value'),quote);
  }
  set('도달한 계정 12%p','12%');assert.ok(localEvidenceChecks(m).includes('metric_not_verbatim:reported_value'));
  set('최근 한 달\n1,250\n도달한 계정');
  m.anchors.push({...anchor(),quote:'상위 거주 도시',purpose:'context'});
  m.metric!.denominator='상위 거주 도시';m.metric_sources!.denominator=[2];
  assert.ok(localEvidenceChecks(m).includes('metric_denominator_is_dimension'));
  m.metric!.denominator=null;m.metric_sources!.denominator=[];assert.deepEqual(localEvidenceChecks(m),[]);
});
test('v0.15 clear textless artwork is usable, unreadable text and uncertain visual objects are not',async()=>{
  for(const mode of ['clear_visual','uncertain_visual','unreadable_text']){
    const {result}=await run('design',{statuses:['supported','supported'],transform:(q,r)=>{
      if(q.kind==='VisualInventory'){
        r.regions[0].readability='unreadable';r.regions[0].salient_text=null;
        if(mode==='uncertain_visual')r.regions[0].identification='uncertain';
      }
      if(q.kind==='DesignExtraction'&&mode!=='unreadable_text'){
        const e=r.evidence[0];e.category='artifact';e.basis='visual_observation';e.statement='선명한 곡선형 로고';
        e.details=details('design','artifact');e.anchors[0]={...e.anchors[0],kind:'visual',purpose:'artifact',quote:null,visual_description:e.statement};
      }return r;
    }});
    assert.equal(result.evidence.some(e=>e.question_eligible),mode==='clear_visual',mode);
    assert.equal(result.questions.length>0,mode==='clear_visual',mode);
  }
});
test('v0.14 CLI archives actual raw usage and redacts the key even if analysis fails; no overwrite',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'proofolio-raw-')),pdf=join(dir,'source.pdf'),raw=join(dir,'raw');
  const key='sk-or-test-000000000000000000';await writeFile(pdf,await pdfBytes());let calls=0;
  const args=[pdf,'--track','design','--max-cost-usd','10','--raw-response-dir',raw,'--budget-ledger',join(dir,'ledger')];
  const deps={env:{OPENROUTER_API_KEY:key},stdout:()=>{},stderr:()=>{},analyze:async(_b:Uint8Array,options:Parameters<typeof analyzePdf>[1])=>{
    calls++;options.onResponse?.('QuestionSet',{usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:.001},note:key},'fixture');throw new Error('fixture failure');
  }};
  assert.equal(await runCli(args,deps),1);
  const text=await readFile(join(raw,'001.json'),'utf8');assert.ok(!text.includes(key));assert.match(text,/REDACTED/);
  assert.equal(JSON.parse(text).raw.usage.prompt_tokens,10);assert.equal((await stat(join(raw,'001.json'))).mode&0o777,0o600);
  assert.equal(await runCli(args,deps),1);assert.equal(calls,1);
  for(const max of ['0','11','1.5'])assert.equal(await runCli([...args,'--max-questions',max],deps),1);
  assert.equal(calls,1);
});
