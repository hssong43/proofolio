import {readFileSync,writeFileSync,appendFileSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createCanvas} from '@napi-rs/canvas';
import * as z from 'zod';
import {readPdf,openRenderer,renderPage,textSpans,savePreviews,MAX_PDF_BYTES} from './pdf.ts';
import {sha256,analyzePdf} from './pipeline.ts';
import {Budget,BudgetError,usageCost} from './llm.ts';
import {readPdfFile} from './cli.ts';
import {loadRuntimeEnv,executionBudget} from './env.ts';
import {interviewGuide} from './questions.ts';
import {Track} from './schema.ts';
// Read-only compatibility for saved Gemini/GCP reports; no legacy API execution.
const OPUS_MODEL='claude-opus-5';
function vertexUsage(raw:unknown) {
  const u=raw as Record<string,number>|null;
  const count=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(!u||!count(u.input_tokens)||!count(u.output_tokens)||!count(u.cache_read_input_tokens??0)||
    !count(u.cache_creation_input_tokens??0)||(u.cache_creation_input_tokens??0)!==0)throw new BudgetError('Stored Opus usage unavailable.');
  const cached=u.cache_read_input_tokens??0,input=u.input_tokens+cached,total=input+u.output_tokens;
  if(!count(input)||!count(total))throw new BudgetError('Stored Opus token totals invalid.');
  return {promptTokenCount:input,candidatesTokenCount:u.output_tokens,totalTokenCount:total,cachedContentTokenCount:cached};
}
import {OPENROUTER_MODELS,openRouterUsage,validateOpenRouterKey} from './openrouter.ts';

const Source=z.object({id:z.string().regex(/^[a-z][a-z0-9-]+$/),author:z.string().min(1),track:Track,language:z.enum(['ko','en']),
  subtype:z.string(),source_url:z.url(),pdf_url:z.url().optional(),pdf_match:z.string().optional(),source_basis:z.string(),public_conditions:z.string()}).strict();
export const Corpus=z.array(Source.extend({split:z.enum(['dev','holdout']),sha256:z.string().regex(/^[a-f0-9]{64}$/),page_count:z.number().int().min(1).max(60)})).superRefine((rows,ctx)=>{
  if(rows.length!==20||['design','marketing'].some(track=>rows.filter(r=>r.track===track).length!==10||rows.filter(r=>r.track===track&&r.split==='dev').length!==3))ctx.addIssue({code:'custom',message:'20 documents, 10 per track, 3 development per track required.'});
  for(const key of ['id','author','sha256'] as const)if(new Set(rows.map(r=>r[key])).size!==rows.length)ctx.addIssue({code:'custom',message:'Duplicate '+key});
});
export const Gold=z.object({id:z.string(),source_sha256:z.string(),reviewer:z.literal('Codex visual inspection; not a human expert'),created_at:z.iso.datetime(),
  reviewed_pages:z.array(z.number().int().positive()).min(1),projects:z.array(z.object({title:z.string(),pages:z.array(z.number().int().positive()).min(1)})).min(1),
  points:z.array(z.object({id:z.string(),pages:z.array(z.number().int().positive()).min(1),observation:z.string(),required_context_pages:z.array(z.number().int().positive())})).min(3),
  cautions:z.array(z.string()).min(1)}).strict();
const root='output/benchmark';
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const fresh=(path:string,data:unknown)=>writeFileSync(path,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
export function codeHash(){return sha256([...readdirSync('src').filter(n=>n.endsWith('.ts')).map(n=>'src/'+n),'package-lock.json','tsconfig.json'].sort().map(p=>p+'\0'+readFileSync(p,'utf8')).join('\0'));}
async function download(url:string,max:number){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Public HTTPS URLs only.');
  const r=await fetch(u,{signal:AbortSignal.timeout(60_000)});if(!r.ok)throw new Error('Public download HTTP '+r.status);
  if(Number(r.headers.get('content-length'))>max)throw new Error('Download size limit.');
  const chunks:Uint8Array[]=[];let size=0;
  if(r.body)for await(const c of r.body){size+=c.length;if(size>max)throw new Error('Download size limit.');chunks.push(c);}
  return {bytes:Buffer.concat(chunks),final_url:r.url};
}
export async function contactSheets(bytes:Uint8Array,directory:string){
  const renderer=await openRenderer(bytes),texts:Array<{page:number;text:string}>=[];
  try{for(let start=1;start<=renderer.numPages;start+=12){
    const sheet=createCanvas(1800,4*380),ctx=sheet.getContext('2d');ctx.fillStyle='#ddd';ctx.fillRect(0,0,1800,1520);
    for(let p=start;p<start+12&&p<=renderer.numPages;p++){
      const canvas=await renderPage(renderer,p,undefined,570),i=p-start,x=(i%3)*600,y=Math.floor(i/3)*380;
      const ratio=Math.min(570/canvas.width,340/canvas.height);ctx.drawImage(canvas,x+15,y+30,canvas.width*ratio,canvas.height*ratio);
      ctx.fillStyle='#111';ctx.font='20px sans-serif';ctx.fillText('Physical page '+p,x+15,y+23);
      texts.push({page:p,text:(await textSpans(renderer,p)).map(t=>t.text).join(' ')});
    }
    writeFileSync(join(directory,`sheet-${String(start).padStart(3,'0')}.png`),sheet.toBuffer('image/png'),{flag:'wx',mode:0o600});
  }fresh(join(directory,'text-layer.json'),texts);}finally{await renderer.loadingTask.destroy();}
}
async function prepare(candidatesPath:string,ids:string[]){
  const candidates=z.array(Source).parse(json(candidatesPath));mkdirSync(join(root,'sources'),{recursive:true,mode:0o700});
  for(const s of candidates.filter(s=>!ids.length||ids.includes(s.id))){
    const directory=join(root,'sources',s.id);if(existsSync(directory)){console.log(s.id+(existsSync(join(directory,'text-layer.json'))?' prepared; unchanged':' exists but incomplete/failed; not overwritten'));continue;}
    mkdirSync(directory,{mode:0o700});
    try{const source=await download(s.source_url,8_000_000),html=source.bytes.toString('utf8');
      let pdf=s.pdf_url;
      if(!pdf){const found=[...html.matchAll(/["']([^"'<>]+\.pdf[^"'<>]*)["']/gi)].map(m=>m[1].replaceAll('&amp;','&'))
        .find(p=>p.length<1000&&(!s.pdf_match||p.includes(s.pdf_match)));if(!found)throw new Error('No public author PDF link.');pdf=new URL(found,s.source_url).href;}
      const result=await download(pdf,MAX_PDF_BYTES),document=await readPdf(result.bytes);
      const meta={...s,pdf_url:pdf,source_final_url:source.final_url,pdf_final_url:result.final_url,retrieved_at:new Date().toISOString(),
        page_count:document.getPageCount(),bytes:result.bytes.length,sha256:sha256(result.bytes),source_page_sha256:sha256(source.bytes)};
      writeFileSync(join(directory,'source.pdf'),result.bytes,{flag:'wx',mode:0o600});fresh(join(directory,'metadata.json'),meta);
      await contactSheets(result.bytes,directory);console.log(JSON.stringify({id:s.id,pages:meta.page_count,bytes:meta.bytes,sha256:meta.sha256}));
    }catch(e){fresh(join(directory,'prepare-error.json'),{id:s.id,at:new Date().toISOString(),error:(e as Error).message});console.log(s.id+' rejected during preparation: '+(e as Error).message);}
  }
}
export function validateGold(corpus:z.infer<typeof Corpus>){
  return corpus.map(s=>{const g=Gold.parse(json(`benchmark/gold/${s.id}.json`));
    if(g.id!==s.id||g.source_sha256!==s.sha256||new Set(g.reviewed_pages).size!==s.page_count||g.reviewed_pages.some(p=>p>s.page_count)
      ||[...g.projects.flatMap(p=>p.pages),...g.points.flatMap(p=>[...p.pages,...p.required_context_pages])].some(p=>!g.reviewed_pages.includes(p)))throw new Error('Incomplete or mismatched source gold: '+s.id);
    return g;});
}
async function run(phase:string,runId:string,ids:string[],models:{model:string;skimModel:string;reviewModel:string;questionModel:string;limit:number;ledger:string}){
  if(phase!=='pilot'||!/^[a-z0-9-]+$/.test(runId))throw new Error('Only the current pilot and a unique safe run ID are supported.');
  const corpus=Corpus.parse(json('benchmark/corpus.json')),gold=validateGold(corpus),hash=codeHash();
  if(new Set(ids).size!==ids.length||ids.some(id=>!corpus.some(s=>s.id===id)))throw new Error('Unknown/duplicate document ID.');
  if(phase!=='pilot'||JSON.stringify([...ids].sort())!==JSON.stringify(['d-shuu','m-damyul']))
    throw new Error('OpenRouter pilot is limited to d-shuu,m-damyul with a new run manifest, not the old GCP freeze.');
  const selected=corpus.filter(s=>ids.includes(s.id));
  if(!selected.length)throw new Error('No eligible documents.');
  const directory=join(root,'runs',runId);mkdirSync(join(root,'runs'),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});
  const budget=new Budget(models.ledger,models.limit,'openrouter'),{model,skimModel,reviewModel,questionModel}=models;
  let stop=false,failed=0;
  const controller=new AbortController(),pause=()=>{stop=true;controller.abort(new Error('사용자 중단: 전송된 요청만 정산하고 종료합니다.'));};
  process.on('SIGINT',pause);process.on('SIGTERM',pause);
  try{
    fresh(join(directory,'run.json'),{phase,mode:'full_pipeline',runId,provider:'openrouter',code_sha256:hash,
      corpus_sha256:sha256(readFileSync('benchmark/corpus.json')),gold_sha256:sha256(JSON.stringify(gold)),
      model,skim_model:skimModel,review_model:reviewModel,question_model:questionModel,
      started_at:new Date().toISOString(),documents:selected.map(s=>s.id),budget_before:budget.snapshot()});
    for(const s of selected){const dir=join(directory,s.id);mkdirSync(dir,{mode:0o700});
    if(stop){fresh(join(dir,'error.json'),{status:controller.signal.aborted?'unattempted_user_pause':'unattempted_after_failure',budget:budget.snapshot()});continue;}
    let raw=0;const started=performance.now();
    try{const bytes=await readPdfFile(join(root,'sources',s.id,'source.pdf'));if(sha256(bytes)!==s.sha256)throw new Error('Source hash mismatch.');
      if(codeHash()!==hash)throw new Error('Code changed during the frozen run.');
      const result=await analyzePdf(bytes,{track:s.track,model,skimModel,reviewModel,questionModel,provider:'openrouter',
        apiKey:process.env.OPENROUTER_API_KEY,budget,signal:controller.signal,
        onEvent:event=>{appendFileSync(join(dir,'events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});console.log(JSON.stringify({id:s.id,event:event.type,elapsed_ms:event.elapsed_ms}));},
        onResponse:(kind,response,requestModel)=>fresh(join(dir,`raw-${String(++raw).padStart(3,'0')}-${kind}.json`),{...(response as object),_request_model:requestModel,_request_stage:kind,_request_provider:'openrouter'})});
      fresh(join(dir,'result.json'),result);writeFileSync(join(dir,'questions.txt'),interviewGuide(result),{flag:'wx',mode:0o600});
      await savePreviews(bytes,result.visual_inventory,join(dir,'regions'));
      fresh(join(dir,'completion.json'),{status:'completed',elapsed_ms:Math.round(performance.now()-started),budget:budget.snapshot()});
    }catch(e){failed++;const message=(e as Error).message;stop=controller.signal.aborted||e instanceof BudgetError||budget.blocked||/HTTP (401|403|429)/.test(message);
      fresh(join(dir,'error.json'),{status:controller.signal.aborted?'interrupted_user_pause':'failed',error:message,elapsed_ms:Math.round(performance.now()-started),budget:budget.snapshot()});console.log(JSON.stringify({id:s.id,error:message,stop}));}
  }}finally{process.off('SIGINT',pause);process.off('SIGTERM',pause);try{
    fresh(join(directory,'budget-after.json'),budget.snapshot());
  }finally{budget.close();}}
  if(failed||controller.signal.aborted)throw new Error('Benchmark incomplete; preserved failures and unattempted documents in '+directory);
}
export const Audit=z.object({reviewer:z.literal('Codex visual inspection; not a human expert'),result_sha256:z.string(),
  questions:z.array(z.object({id:z.string(),grounded:z.boolean(),wrong_page_or_evidence:z.boolean(),unsupported_premise:z.boolean(),duplicate:z.boolean(),note:z.string()})),
  bad_boxes:z.array(z.string()),covered_gold_points:z.array(z.string()),notes:z.array(z.string()),
  final_source_errors:z.array(z.string()).optional(),selected_points_complete:z.boolean().optional(),substantive_questions:z.number().int().nonnegative().optional()});
export function tokenTotals(usage:Array<Record<string,any>>){
  const sum=(key:string,optional=false)=>usage.reduce<number|null>((n,u)=>{
    const v=u[key]===undefined&&optional?0:u[key];return n!==null&&Number.isSafeInteger(v)&&v>=0?n+v:null;
  },0);
  return {input:sum('promptTokenCount'),output:sum('candidatesTokenCount'),thinking:sum('thoughtsTokenCount'),cached:sum('cachedContentTokenCount',true),total:sum('totalTokenCount')};
}
export function responseUsage(raws:Array<Record<string,any>>,fallbackModel:string,unresolvedProviders:string[]=[]){
  const rows=raws.map(raw=>{
    const model=raw._request_model??fallbackModel,provider=raw._request_provider==='openrouter'||Object.values(OPENROUTER_MODELS).includes(model)?'openrouter':model===OPUS_MODEL?'vertex':'gemini';
    try{const routed=provider==='openrouter'?openRouterUsage(raw.usage):null;
      let usage=routed?{promptTokenCount:routed.promptTokenCount,candidatesTokenCount:routed.candidatesTokenCount,totalTokenCount:routed.totalTokenCount,
        thoughtsTokenCount:routed.thinking_tokens,cachedContentTokenCount:routed.cached_tokens}:provider==='vertex'?{...vertexUsage(raw.usage),thoughtsTokenCount:null}:raw.usageMetadata;
      const cost=routed?routed.cost_usd:usageCost(model,provider==='vertex'?vertexUsage(raw.usage):usage);
      const partialError=routed?.totalTokenCount===0&&raw.choices?.some((c:any)=>
        (c.error||c.finish_reason==='error')&&typeof c.message?.content==='string'&&c.message.content.length>0);
      // Partial text plus zero native counters does not prove zero tokens. Keep API cost but never estimate missing tokens.
      if(partialError)usage={promptTokenCount:null,candidatesTokenCount:null,totalTokenCount:null,thoughtsTokenCount:null,cachedContentTokenCount:null};
      return {model,provider,stage:raw._request_stage??null,usage,cost_usd:cost,output_includes_thinking:provider!=='gemini',
        ...(partialError?{token_usage_status:'unconfirmed_partial_error'}:{})};
    }catch{return {model,provider,stage:raw._request_stage??null,usage:{cachedContentTokenCount:null},cost_usd:null,output_includes_thinking:provider!=='gemini'};}
  });
  const summarize=(items:typeof rows,pending:boolean)=>({
    tokens:pending?{input:null,output:null,thinking:null,cached:null,total:null}:tokenTotals(items.map(r=>r.usage)),
    recorded_tokens:tokenTotals(items.map(r=>r.usage)),unresolved_call:pending,unknown_usage_responses:items.filter(r=>r.cost_usd===null).length,
    known_cost_usd:items.reduce((n,r)=>n+(r.cost_usd??0),0),cost_usd:pending||items.some(r=>r.cost_usd===null)?null:items.reduce((n,r)=>n+r.cost_usd!,0)});
  return {...summarize(rows,unresolvedProviders.length>0),
    application_http_retries:raws.filter(r=>Number.isSafeInteger(r._application_http_attempt)&&r._application_http_attempt>1).length,
    providers:Object.fromEntries([...new Set([...rows.map(r=>r.provider),...unresolvedProviders])]
    .map(p=>[p,{...summarize(rows.filter(r=>r.provider===p),unresolvedProviders.includes(p)),output_includes_thinking:p!=='gemini'}])),rows};
}
export function pilotPass(result:{questions:unknown[];quality?:{status:string}},audit:z.infer<typeof Audit>|null){
  return !!audit&&result.questions.length>=3&&result.quality?.status==='ready'&&audit.selected_points_complete===true&&
    audit.final_source_errors?.length===0&&(audit.substantive_questions??0)>=2&&audit.substantive_questions!<=result.questions.length&&
    audit.questions.length===result.questions.length&&audit.questions.every(q=>q.grounded&&!q.wrong_page_or_evidence&&!q.unsupported_premise&&!q.duplicate);
}
export function trackThreshold(rows:Array<{pass:boolean;reviewed:boolean;questions:number;wrong_page_or_evidence?:number|null;unsupported_premise?:number|null}>){
  return rows.length===10&&rows.filter(r=>r.pass).length>=8&&rows.every(r=>r.questions===0||
    (r.reviewed&&r.wrong_page_or_evidence===0&&r.unsupported_premise===0));
}
export function report(runId:string){
  if(!/^[a-z0-9-]+$/.test(runId))throw new Error('Invalid run id.');
  const corpus=Corpus.parse(json('benchmark/corpus.json')),directory=join(root,'runs',runId),runInfo=json(join(directory,'run.json'));
  const rows=corpus.filter(s=>runInfo.documents.includes(s.id)).map(s=>{
    const dir=join(directory,s.id),path=join(dir,'result.json'),g=Gold.parse(json(`benchmark/gold/${s.id}.json`));
    const rawFiles=readdirSync(dir).filter(n=>/^raw-.*\.json$/.test(n)).sort();
    const raws=rawFiles.map(n=>{const r=json(join(dir,n));return {...r,_request_stage:r._request_stage??n.replace(/^raw-\d+-|\.json$/g,'')};});
    const failure=existsSync(join(dir,'error.json'))?json(join(dir,'error.json')):null;
    const unresolved=failure?.status?.startsWith('unattempted')?[]:
      [[runInfo.provider==='openrouter'?'openrouter':'gemini',failure?.budget],['vertex',failure?.vertex_budget]].filter(([,b])=>(b?.active_reserved_usd??b?.reserved_usd)>0).map(([p])=>String(p));
    const accounting=responseUsage(raws,runInfo.model,unresolved),totals=accounting.tokens,unknownUsage=accounting.unknown_usage_responses;
    const costUnknown=accounting.cost_usd===null;
    const costs={known_cost_usd:accounting.known_cost_usd,cost_usd:costUnknown?null:accounting.cost_usd,
      cost_may_be_unknown:costUnknown,providers:accounting.providers,provider_retries:null,
      application_http_retries:accounting.application_http_retries};
    if(!existsSync(path)){
      return {id:s.id,track:s.track,status:failure?.status??'unattempted',error:failure?.error??null,total_ms:failure?.elapsed_ms??null,
        questions:0,grounded_unique:null,reviewed:false,pass:false,pilot_pass:false,tokens:totals,...costs,unknown_usage_responses:unknownUsage,
        cost_per_passed_question_usd:null,
        missed_gold_points:g.points.map(p=>p.id)};}
    const result=json(path),auditPath=join(dir,'source-audit.json'),audit=existsSync(auditPath)?Audit.parse(json(auditPath)):null;
    if(audit&&(audit.result_sha256!==sha256(readFileSync(path))||audit.questions.length!==result.questions.length||new Set(audit.questions.map(q=>q.id)).size!==result.questions.length
      ||audit.questions.some(q=>!result.questions.some((r:{id:string})=>r.id===q.id))||audit.covered_gold_points.some(id=>!g.points.some(p=>p.id===id))))throw new Error('Audit IDs/hash mismatch: '+s.id);
    const supported=audit?.questions.filter(q=>q.grounded&&!q.wrong_page_or_evidence&&!q.unsupported_premise&&!q.duplicate).length??0;
    return {id:s.id,track:s.track,status:result.status,artifact_failure:existsSync(join(dir,'error.json'))?json(join(dir,'error.json')).error:null,
      questions:result.questions.length,reviewed:!!audit,grounded_unique:supported,
      wrong_page_or_evidence:audit?.questions.filter(q=>q.wrong_page_or_evidence).length??null,unsupported_premise:audit?.questions.filter(q=>q.unsupported_premise).length??null,
      duplicate:audit?.questions.filter(q=>q.duplicate).length??null,bad_boxes:audit?.bad_boxes.length??null,
      missed_gold_points:audit?g.points.filter(p=>!audit.covered_gold_points.includes(p.id)).map(p=>p.id):null,
      rejected_questions:result.question_checks.filter((q:{status:string})=>q.status==='rejected').length,rejected_evidence:result.rejected_candidates.length,
      selected_pages:result.analysis_plan.selected_pages,total_ms:result.metrics.total_ms,first_evidence_ms:result.metrics.first_evidence_ms,
      stages:result.metrics.stages,usage:result.metrics.usage,tokens:totals,...costs,unknown_usage_responses:unknownUsage,cleanup_failures:result.metrics.cleanup_failures,
      question_stage_cost_usd:costUnknown?null:responseUsage(raws.filter(r=>['QuestionSet','QuestionReviews'].includes(r._request_stage)),runInfo.model).cost_usd,
      cost_per_passed_question_usd:supported&&costs.cost_usd!==null?costs.cost_usd/supported:null,
      first_draft_usage:responseUsage(raws.filter(r=>r._request_stage==='QuestionSet').slice(0,1),runInfo.model),
      question_batches:result.metrics.stages.filter((r:any)=>r.stage==='QuestionSet'&&r.attempt===1).length,
      schema_retries:result.metrics.stages.filter((r:any)=>r.attempt>1).length,
      pilot_pass:pilotPass(result,audit),
      pass:!!audit&&supported>=3&&!audit.questions.some(q=>q.wrong_page_or_evidence||q.unsupported_premise)};
  });
  const tracks=['design','marketing'].map(track=>{const selected=rows.filter(r=>r.track===track);return {track,documents:selected.length,
    passes:selected.filter(r=>r.pass).length,reviewed:selected.filter(r=>r.reviewed).length,
    meets_target:trackThreshold(selected),tokens:tokenTotals(selected.map(r=>({promptTokenCount:r.tokens.input,candidatesTokenCount:r.tokens.output,
      thoughtsTokenCount:r.tokens.thinking,cachedContentTokenCount:r.tokens.cached,totalTokenCount:r.tokens.total}))),
    known_cost_usd:selected.reduce((sum,r)=>sum+r.known_cost_usd,0),
    cost_usd:selected.some(r=>r.cost_usd===null)?null:selected.reduce((sum,r)=>sum+r.cost_usd!,0),
    mean_document_ms:selected.filter(r=>typeof r.total_ms==='number').reduce((sum,r)=>sum+(r.total_ms??0),0)/Math.max(1,selected.filter(r=>typeof r.total_ms==='number').length)};});
  const result={run:runInfo,review_method:'Automated source checks plus separate Codex visual source inspection, not human expert review',
    conclusion:tracks.every(t=>t.meets_target)?'meets_this_corpus_thresholds':'not_demonstrated',
    pilot_status:runInfo.phase==='pilot'?(rows.length===2&&rows.every(r=>r.pilot_pass)?'two_document_pilot_passed':'not_demonstrated'):null,
    pilot_scope:runInfo.mode??'full_pipeline',tracks,documents:rows,budget:json(join(directory,'budget-after.json')),
    vertex_budget:existsSync(join(directory,'vertex-budget-after.json'))?json(join(directory,'vertex-budget-after.json')):null};
  fresh(join(directory,'report.json'),result);
  const lines=['# Portfolio question benchmark', '',result.conclusion,'','Separate Codex source review is not a human expert audit or a general Gemini accuracy estimate.','',
    '| Document | Track | Status | Raw questions | Grounded distinct | Source audited | Pass |','|---|---|---|---:|---:|---|---|',
    ...rows.map(r=>`| ${r.id} | ${r.track} | ${r.status} | ${r.questions} | ${r.grounded_unique??'—'} | ${r.reviewed} | ${r.pass} |`),'',
    ...tracks.map(t=>`${t.track}: ${t.passes}/${t.documents} documents; target met: ${t.meets_target}`),'',
    `Pilot (${result.pilot_scope}): ${result.pilot_status??'not applicable'}`,'',
    `${runInfo.provider==='openrouter'?'OpenRouter':'Gemini'} ledger: $${result.budget.spent_usd.toFixed(6)} ${runInfo.provider==='openrouter'?'API-reported cost':'spent estimate'}; account-wide billing cap: no.`,
    ...(result.budget.unknown_cost_hold_usd?[`Prior request cost: unknown; $${result.budget.unknown_cost_hold_usd.toFixed(6)} held unavailable, not counted as actual spend.`]:[]),
    ...(result.vertex_budget?[`GCP ledger: $${result.vertex_budget.spent_usd.toFixed(6)} spent estimate, $${result.vertex_budget.reserved_usd.toFixed(6)} reserved.`]:[])];
  writeFileSync(join(directory,'report.md'),lines.join('\n')+'\n',{flag:'wx',mode:0o600});return result;
}
export async function main(argv=process.argv.slice(2)){
  const {values:v,positionals:p}=parseArgs({args:argv,allowPositionals:true,options:{ids:{type:'string'},run:{type:'string'},phase:{type:'string'},
    provider:{type:'string',default:'openrouter'},'max-cost-usd':{type:'string'},'budget-ledger':{type:'string'},
    model:{type:'string'},'skim-model':{type:'string'},'review-model':{type:'string'},'question-model':{type:'string'}}});
  if(p[0]==='prepare')return prepare(p[1]??'benchmark/candidates.json',v.ids?.split(',')??[]);
  if(p[0]==='run'){
    if(v.provider!=='openrouter')throw new Error('OpenRouter only; direct Gemini/GCP execution was removed.');
    loadRuntimeEnv(process.cwd());validateOpenRouterKey(process.env.OPENROUTER_API_KEY);
    const budget=executionBudget(process.cwd(),process.env,{limit:v['max-cost-usd'],ledger:v['budget-ledger']});
    return run(v.phase??'pilot',v.run??'',v.ids?.split(',')??[],{...budget,
      model:v.model??process.env.OPENROUTER_MODEL??OPENROUTER_MODELS.vision,skimModel:v['skim-model']??process.env.OPENROUTER_SKIM_MODEL??OPENROUTER_MODELS.skim,
      reviewModel:v['review-model']??process.env.OPENROUTER_REVIEW_MODEL??OPENROUTER_MODELS.vision,questionModel:v['question-model']??process.env.OPENROUTER_QUESTION_MODEL??OPENROUTER_MODELS.questions});
  }
  if(p[0]==='report'){console.log(JSON.stringify(report(v.run??'').tracks));return;}
  throw new Error('Usage: npm run benchmark -- prepare [candidates.json] [--ids a,b] | run --phase pilot --run UNIQUE --ids d-shuu,m-damyul --max-cost-usd APPROVED_LIMIT | report --run ID');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
