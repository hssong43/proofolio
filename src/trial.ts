// One explicitly paid, local d-shuu run. No production defaults, historical ledgers or source results are changed.
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {loadRuntimeEnv} from './env.ts';
import {Budget,freshMetrics,type ModelRequest} from './llm.ts';
import {TRIAL_MODELS,openRouterSession} from './openrouter.ts';
import {analyzePdf,sha256} from './pipeline.ts';
import {openRenderer,renderPage,savePreviews} from './pdf.ts';
import {interviewGuide} from './questions.ts';
import {codeHash} from './benchmark.ts';

const {values:v}=parseArgs({options:{paid:{type:'boolean'},run:{type:'string'}}});
if(!v.paid||!v.run||!/^[a-z0-9-]+$/.test(v.run))throw new Error('Explicit --paid --run NEW_ID required. One d-shuu PDF only.');
const env:NodeJS.ProcessEnv={};loadRuntimeEnv(process.cwd(),env); // Private file key; do not inherit the stale injected key.
const key=env.OPENROUTER_API_KEY??'',directory=resolve('output/benchmark/model-trials',v.run);
mkdirSync(resolve(directory,'..'),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});
const fresh=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)
  .replaceAll(key||'__missing_key__','[REDACTED]')+'\n',{flag:'wx',mode:0o600});
const bytes=readFileSync('output/benchmark/sources/d-shuu/source.pdf');
const source=JSON.parse(readFileSync('output/benchmark/sources/d-shuu/metadata.json','utf8'));
if(sha256(bytes)!==source.sha256)throw new Error('Source PDF hash mismatch.');
const frozen=codeHash(),stats=freshMetrics(),started=performance.now();
const budget=new Budget(join(directory,'budget.jsonl'),23,'openrouter');
const controller=new AbortController(),pause=()=>controller.abort(new Error('Single trial interrupted.'));
process.on('SIGINT',pause);process.on('SIGTERM',pause);
let responseIndex=0,requestIndex=0;
const session=openRouterSession(key,stats,budget,{profile:'astra-sonnet-opus',signal:controller.signal,
  onResponse:(kind,raw,model)=>{
    fresh(`raw-${String(++responseIndex).padStart(3,'0')}-${kind}.json`,{...(raw as object),_request_model:model,_request_stage:kind,_request_provider:'openrouter'});
    console.log(JSON.stringify({response:responseIndex,stage:kind,model,cost_usd:stats.estimated_cost_usd}));
  }});
const pageImages=new Map<string,Array<[string,Uint8Array]>>();
try{
  fresh('manifest.json',{created_at:new Date().toISOString(),document_id:'d-shuu',source_sha256:source.sha256,
    code_sha256:frozen,models:TRIAL_MODELS,question_target:10,scope:{pages:5,points:3,projects:2},
    budget_authority:'User replaced old active constraints with USD23 available and authorized exactly one test.',
    approved_run_limit_usd:23,account_balance_status:'user_reported_not_verified',
    historical_ledger_path:'output/openrouter-budget.jsonl',historical_ledger_sha256:sha256(readFileSync('output/openrouter-budget.jsonl')),
    historical_unknown_costs:'preserved unchanged; not treated as settled or current run spending',
    transport:'PDF chunks rendered to ordered PNG pages, 2200px; Astra original detail; JSON mode plus unchanged local Zod',
    automatic_full_run_retries:0,format_retries_per_stage:1,rate_limit_retries_per_call:2,budget_before:budget.snapshot()});
  fresh('preflight.json',await session.checkAccess());
  const generate=async(request:ModelRequest)=>{
    if(codeHash()!==frozen)throw new Error('Code changed during the frozen single run.');
    if(request.pdf){
      const hash=sha256(request.pdf);let pages=pageImages.get(hash);
      if(!pages){
        const renderer=await openRenderer(request.pdf);pages=[];
        try{for(let page=1;page<=renderer.numPages;page++)pages.push([
          `첨부 PDF의 로컬 페이지=${page}/${renderer.numPages}; 원본 페이지 매핑은 지시문을 따른다.`,
          (await renderPage(renderer,page,undefined,2200)).toBuffer('image/png')]);
        }finally{await renderer.loadingTask.destroy();}
        pageImages.set(hash,pages);
      }
      request={...request,pdf:undefined,images:[...pages,...request.images??[]]};
    }
    fresh(`request-${String(++requestIndex).padStart(3,'0')}-${request.kind}.json`,{...request,schema:undefined,
      images:request.images?.map(([label,png])=>({label,sha256:sha256(png),bytes:png.length}))});
    const start=performance.now();stats.model_calls++;
    console.log(JSON.stringify({request:requestIndex,stage:request.kind,model:request.model,elapsed_ms:Math.round(start-started)}));
    try{return await session.generate(request);}
    finally{stats.stages.push({stage:request.kind,attempt:1,elapsed_ms:Math.round(performance.now()-start)});}
  };
  const result=await analyzePdf(bytes,{track:'design',model:TRIAL_MODELS.vision,skimModel:TRIAL_MODELS.vision,
    questionModel:TRIAL_MODELS.questions,reviewModel:TRIAL_MODELS.review,maxQuestions:10,pageBudget:5,
    generate,signal:controller.signal,onEvent:event=>{
      // Pipeline-local metrics omit the injected transport; the final result below joins both records.
      if(event.type!=='complete')appendFileSync(join(directory,'events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});
      console.log(JSON.stringify({event:event.type,elapsed_ms:event.elapsed_ms}));
    }});
  const stages=result.metrics.stages,firstEvidence=result.metrics.first_evidence_ms;
  stats.total_ms=Math.round(performance.now()-started);
  result.metrics={...stats,stages,first_evidence_ms:firstEvidence};
  fresh('result.json',result);
  writeFileSync(join(directory,'questions.txt'),interviewGuide(result),{flag:'wx',mode:0o600});
  await savePreviews(bytes,result.visual_inventory,join(directory,'regions'));
  console.log(JSON.stringify({completed:true,status:result.status,questions:result.questions.length,cost_usd:stats.estimated_cost_usd,directory}));
}catch(e){
  stats.total_ms=Math.round(performance.now()-started);
  fresh('error.json',{message:(e as Error).message,metrics:stats,budget:budget.snapshot()});
  console.error((e as Error).message.replaceAll(key||'__missing_key__','[REDACTED]'));process.exitCode=1;
}finally{
  await session.close();fresh('budget-after.json',budget.snapshot());budget.close();
  process.off('SIGINT',pause);process.off('SIGTERM',pause);
}
