// Resume orchestration only: the frozen src/* analysis and its settings stay unchanged.
import {appendFileSync,existsSync,mkdirSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {Corpus,codeHash,validateGold,tokenTotals,main as benchmarkMain} from '../src/benchmark.ts';
import {Budget,BudgetError,usageCost,priceFor,MAX_OUTPUT_TOKENS} from '../src/gemini.ts';
import {loadEnv,readPdfFile} from '../src/cli.ts';
import {analyzePdf,sha256} from '../src/pipeline.ts';
import {savePreviews} from '../src/pdf.ts';
import {interviewGuide} from '../src/questions.ts';

const root='output/benchmark';
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const fresh=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
export function reserveWithin(budget:Budget,ceiling:number,reserve:Budget['reserve'],model:string,input:number,output=MAX_OUTPUT_TOKENS){
  if(!Number.isFinite(ceiling)||ceiling<0||ceiling>budget.limit)throw new BudgetError('Invalid additional-spend ceiling.');
  const price=priceFor(model),maximum=(input*price.input+output*price.output)/1e6;
  if(budget.spent+budget.reserved+maximum>ceiling+1e-9)throw new BudgetError('Approved additional USD 5 ceiling reached.');
  return reserve.call(budget,model,input,output);
}
function spendCeiling(){
  const window=json(join(root,'spend-window-2026-09-16.json'));
  if(window.additional_limit_usd!==5||window.absolute_ceiling_usd!==window.baseline_booked_usd+5)throw new BudgetError('Spend window mismatch.');
  return Math.min(10,window.absolute_ceiling_usd);
}
export function priorAction(directory:string):'reuse'|'resume' {
  if(existsSync(join(directory,'result.json'))||existsSync(join(directory,'completion.json')))return 'reuse';
  if(existsSync(join(directory,'error.json'))){const status=String(json(join(directory,'error.json')).status);
    if(status!=='interrupted'&&!status.startsWith('unattempted'))return 'reuse';}
  return 'resume';
}
export function resumePlan(from:string,run:string){
  if(![from,run].every(s=>/^[a-z0-9-]+$/.test(s))||from===run)throw new Error('Distinct safe run IDs required.');
  const old=join(root,'runs',from),destination=join(root,'runs',run);
  if(existsSync(destination))throw new Error('Destination exists; never overwrite a run.');
  const corpus=Corpus.parse(json('benchmark/corpus.json')),gold=validateGold(corpus),frozen=json('benchmark/freeze.json'),previous=json(join(old,'run.json'));
  if(codeHash()!==frozen.code_sha256||previous.code_sha256!==frozen.code_sha256||previous.model!==frozen.model
    ||sha256(readFileSync('benchmark/corpus.json'))!==frozen.corpus_sha256||sha256(JSON.stringify(gold))!==frozen.gold_sha256)
    throw new Error('Frozen code/corpus/gold/model mismatch.');
  if(previous.phase!=='final'||JSON.stringify(previous.documents)!==JSON.stringify(corpus.map(s=>s.id)))throw new Error('Previous final run must preserve all 20 cases.');
  const documents=corpus.map(s=>({...s,prior_directory:join(old,s.id),action:priorAction(join(old,s.id))}));
  for(const d of documents)if(existsSync(join(d.prior_directory,'result.json'))&&json(join(d.prior_directory,'result.json')).document.sha256!==d.sha256)
    throw new Error('Prior result source hash mismatch: '+d.id);
  return {from,run,old,destination,frozen,documents};
}
export async function resume(from:string,run:string){
  const p=resumePlan(from,run),ceiling=spendCeiling();loadEnv('.env');const budget=new Budget(join(root,'api-budget.jsonl'),10);
  const reserve=budget.reserve;
  budget.reserve=(model,input,output)=>reserveWithin(budget,ceiling,reserve,model,input,output);
  let interrupted=false,blocked=false;
  const interrupt=()=>{interrupted=true;};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try{
    if(budget.blocked)throw new BudgetError('Unresolved budget; no new calls.');
    mkdirSync(p.destination,{mode:0o700});
    const attempts=p.documents.filter(d=>d.action==='resume'&&existsSync(d.prior_directory)).map(d=>{
      const usage=readdirSync(d.prior_directory).filter(n=>/^raw-.*\.json$/.test(n)).map(n=>json(join(d.prior_directory,n)).usageMetadata);
      return {id:d.id,directory:d.prior_directory,status:'interrupted',known_cost_usd:usage.reduce((n,u)=>n+usageCost(p.frozen.model,u),0),tokens:tokenTotals(usage)};
    });
    fresh(join(p.destination,'run.json'),{phase:'final',runId:run,continues:from,code_sha256:p.frozen.code_sha256,
      orchestration_sha256:sha256(readFileSync('benchmark/resume.ts')),model:p.frozen.model,started_at:new Date().toISOString(),
      documents:p.documents.map(d=>d.id),reused:p.documents.filter(d=>d.action==='reuse').map(d=>d.id),interrupted_attempts:attempts,
      absolute_spend_ceiling_usd:ceiling,budget_before:budget.snapshot()});
    for(const d of p.documents){
      const dir=join(p.destination,d.id);
      if(d.action==='reuse'){symlinkSync(resolve(d.prior_directory),dir,'dir');console.log(JSON.stringify({id:d.id,event:'reused'}));continue;}
      mkdirSync(dir,{mode:0o700});
      if(interrupted||blocked){fresh(join(dir,'error.json'),{status:interrupted?'unattempted_interrupt':'unattempted_budget',budget:budget.snapshot()});continue;}
      let raw=0;const started=performance.now();
      try{
        const bytes=await readPdfFile(join(root,'sources',d.id,'source.pdf'));if(sha256(bytes)!==d.sha256)throw new Error('Source hash mismatch.');
        const result=await analyzePdf(bytes,{track:d.track,model:p.frozen.model,scope:p.frozen.scope,pageBudget:p.frozen.page_budget,apiKey:process.env.GEMINI_API_KEY,budget,
          onEvent:event=>{appendFileSync(join(dir,'events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});
            console.log(JSON.stringify({id:d.id,event:event.type,elapsed_ms:event.elapsed_ms}));
            if(interrupted&&event.type==='stage')throw new Error('Operator interruption; pending calls were allowed to settle.');},
          onResponse:(kind,response)=>fresh(join(dir,`raw-${String(++raw).padStart(3,'0')}-${kind}.json`),response)});
        fresh(join(dir,'result.json'),result);writeFileSync(join(dir,'questions.txt'),interviewGuide(result),{flag:'wx',mode:0o600});
        await savePreviews(bytes,result.visual_inventory,join(dir,'regions'));
        fresh(join(dir,'completion.json'),{status:'completed',elapsed_ms:Math.round(performance.now()-started),budget:budget.snapshot()});
      }catch(e){blocked=e instanceof BudgetError||budget.blocked;
        fresh(join(dir,'error.json'),{status:interrupted?'interrupted':'failed',error:(e as Error).message,elapsed_ms:Math.round(performance.now()-started),budget:budget.snapshot()});
        console.log(JSON.stringify({id:d.id,error:(e as Error).message,stop:interrupted||blocked}));}
    }
  }finally{
    process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
    try{if(existsSync(p.destination))fresh(join(p.destination,'budget-after.json'),budget.snapshot());}finally{budget.close();}
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values:v}=parseArgs({options:{from:{type:'string'},run:{type:'string'},execute:{type:'boolean'},repeat:{type:'boolean'}}});
  if(v.repeat&&v.execute){
    const ceiling=spendCeiling(),reserve=Budget.prototype.reserve;
    // Only the reservation ceiling is wrapped; existing repeat runner and frozen analysis are reused.
    Budget.prototype.reserve=function(model,input,output){return reserveWithin(this,ceiling,reserve,model,input,output);};
    try{await benchmarkMain(['run','--phase','repeat','--run',v.run??'','--ids',json('benchmark/freeze.json').repeat_documents.join(',')]);}
    finally{Budget.prototype.reserve=reserve;}
  }else if(v.execute)await resume(v.from??'',v.run??'');
  else console.log(JSON.stringify(resumePlan(v.from??'',v.run??'').documents.map(d=>({id:d.id,action:d.action})),null,2));
}
