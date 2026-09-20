// Explicit paid source/question replay. Never reruns skim/extraction or changes historical results.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {loadRuntimeEnv,executionBudget} from '../src/env.ts';
import {Budget,freshMetrics} from '../src/llm.ts';
import {OPENROUTER_MODELS,openRouterSession} from '../src/openrouter.ts';
import {sha256,verifyEvidenceCrops,localEvidenceChecks,type AnalysisResult} from '../src/pipeline.ts';
import {modelRequest,generateQuestions,questionQuality,interviewGuide} from '../src/questions.ts';
import {openRenderer,renderPage,textCropTouchesEdge} from '../src/pdf.ts';
import {codeHash} from '../src/benchmark.ts';
import type {CropReading,ResolvedEvidence} from '../src/schema.ts';

const {values:v}=parseArgs({options:{input:{type:'string'},id:{type:'string'},run:{type:'string'},stage:{type:'string'},
  paid:{type:'boolean'},'max-cost-usd':{type:'string'},'question-max-output-tokens':{type:'string',default:'16384'}}});
if(!v.paid||!v.input||!v.run||!/^[a-z0-9-]+$/.test(v.run)||!['d-shuu','m-damyul'].includes(v.id??'')||!['sources','questions'].includes(v.stage??''))
  throw new Error('Require --paid --input RESULT --id d-shuu|m-damyul --run NEW_ID --stage sources|questions --max-cost-usd APPROVED_CAP.');
loadRuntimeEnv(process.cwd());
const questionMaxOutputTokens=Number(v['question-max-output-tokens']);
if(!Number.isSafeInteger(questionMaxOutputTokens)||questionMaxOutputTokens<1||questionMaxOutputTokens>16384)throw new Error('Question output cap must be 1..16384.');
const config=executionBudget(process.cwd(),process.env,{limit:v['max-cost-usd']}),baseline=readFileSync(resolve(v.input));
const prior=JSON.parse(baseline.toString()) as AnalysisResult,bytes=readFileSync(`output/benchmark/sources/${v.id}/source.pdf`);
if(sha256(bytes)!==prior.document.sha256||prior.track!==(v.id==='d-shuu'?'design':'marketing'))throw new Error('Source/track mismatch.');
if(v.stage==='questions'&&(!['0.16','0.17'].includes(prior.schema_version)||prior.evidence.some(e=>e.question_eligible&&
  (e.source_check.method!=='blind_crop_reading_then_source_comparison'||e.anchors.some(a=>!a.crop_reading)))))
  throw new Error('Question replay requires new blind-source checks, not a relabelled legacy result.');
const directory=resolve('output/benchmark/quality-replays',v.run);mkdirSync(resolve(directory,'..'),{recursive:true,mode:0o700});
mkdirSync(directory,{mode:0o700});
const fresh=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)
  .replaceAll(process.env.OPENROUTER_API_KEY??'__missing_key__','[REDACTED]')+'\n',{flag:'wx',mode:0o600});
const budget=new Budget(config.ledger,config.limit,'openrouter'),stats=freshMetrics(),frozen=codeHash(),started=performance.now();
const controller=new AbortController(),pause=()=>controller.abort(new Error('User interrupted replay.'));
process.on('SIGINT',pause);process.on('SIGTERM',pause);
let renderer:Awaited<ReturnType<typeof openRenderer>>|undefined,sequence=0;
try{
  const session=openRouterSession(process.env.OPENROUTER_API_KEY??'',stats,budget,{signal:controller.signal,onResponse:(kind,raw,model)=>
    fresh(`raw-${String(++sequence).padStart(3,'0')}-${kind}.json`,{...(raw as object),_request_model:model,_request_stage:kind})});
  fresh('preflight.json',await session.checkAccess());
  fresh('manifest.json',{stage:v.stage,id:v.id,created_at:new Date().toISOString(),source_sha256:sha256(bytes),
    input_sha256:sha256(baseline),input_path:resolve(v.input),code_sha256:frozen,script_sha256:sha256(readFileSync(new URL(import.meta.url))),
    budget_before:budget.snapshot(),question_max_output_tokens:questionMaxOutputTokens,scope:'frozen selection and extraction; not a fresh PDF/web end-to-end test'});
  const request=modelRequest(session.generate,stats,{model:OPENROUTER_MODELS.vision,skimModel:OPENROUTER_MODELS.skim,
    reviewModel:OPENROUTER_MODELS.vision,questionModel:OPENROUTER_MODELS.questions,questionMaxOutputTokens,signal:controller.signal,onRequest:(r,attempt)=>{
      if(codeHash()!==frozen)throw new Error('Source changed during frozen replay.');
      console.log(JSON.stringify({stage:r.kind,attempt,elapsed_ms:Math.round(performance.now()-started)}));
    }});
  renderer=await openRenderer(bytes);const crop=async(a:ResolvedEvidence['anchors'][number])=>{
    const png=(await renderPage(renderer!,a.page,a.box)).toBuffer('image/png');return png;
  };
  let evidence=structuredClone(prior.evidence),questions:AnalysisResult['questions']=[],question_checks:AnalysisResult['question_checks']=[],coverage:Parameters<typeof questionQuality>[2]=[];
  // Replays may narrow old eligibility with current free guards, never retroactively certify old source checks.
  for(const e of evidence.filter(e=>e.question_eligible)){
    const issues=localEvidenceChecks(e);
    for(const a of e.anchors)if(a.quote&&prior.visual_inventory.find(p=>p.page===a.page)?.regions.find(r=>r.key===a.region_key)?.kind==='text_block'&&
      await textCropTouchesEdge(await crop(a)))issues.push('potential_text_crop_clipping');
    if(issues.length){e.question_eligible=false;e.local_checks.push(...issues);e.source_check={status:'unsupported',reason:issues.join('; '),method:'current_local_checks'};}
  }
  if(v.stage==='sources'){
    const candidates=evidence.filter(e=>e.question_eligible),readings=new Map<string,CropReading>();
    const valid=candidates;
    for(let start=0;start<valid.length;start+=4){
      const batch=valid.slice(start,start+4),images:Array<[string,Uint8Array]>=[],seen=new Set<string>();
      for(const e of batch)for(const a of e.anchors)if(!seen.has(a.region_id)){
        seen.add(a.region_id);images.push([a.region_id,await crop(a)]);
      }
      const checked=await verifyEvidenceCrops(batch,batch.map(e=>e.id),images,request,readings);
      for(const e of batch){const review=checked.reviews.find(r=>r.evidence_id===e.id)!;
        e.source_check={status:review.status,reason:review.reason,method:'blind_crop_reading_then_source_comparison',anchor_checks:review.anchor_checks};
        e.question_eligible=review.status==='supported';e.document_support=review.document_support;
        e.anchors=e.anchors.map((a,i)=>{const check=review.anchor_checks.find(c=>c.anchor_index===i+1);
          return {...a,crop_reading:readings.get(a.region_id)!,
            ...(a.kind==='visual'&&check?.status==='supported'?{visual_description:check.reading_excerpt!}:{})};});
        if(e.basis==='visual_observation'&&e.question_eligible)e.statement=e.anchors.find(a=>a.kind==='visual')!.visual_description!;
      }
    }
    fresh('readings.json',[...readings.values()]);
  }else{
    const generated=await generateQuestions(evidence,request,{track:prior.track,selectedPoints:prior.analysis_plan.selected_points,
      evidenceOnly:true,maxQuestions:10,imagesFor:async cards=>{
        const images:Array<[string,Uint8Array]>=[];
        for(const c of cards)for(const a of c.source.anchors)images.push([`question_id=${c.question_id}; region_id=${a.region_id}`,await crop(a)]);
        return images;
      }});
    questions=generated.cards;question_checks=generated.checks;coverage=generated.focusCoverage;
  }
  stats.total_ms=Math.round(performance.now()-started);
  const quality=questionQuality(questions,prior.analysis_plan.selected_points.map(p=>p.id),coverage);
  const result={...prior,schema_version:'0.17',created_at:new Date().toISOString(),evidence,questions,question_checks,quality,
    status:questions.length?(quality.status==='ready'?'evidence_ready':'needs_review'):'insufficient_evidence',
    question_evidence_ids:evidence.filter(e=>e.question_eligible).map(e=>e.id),question_target:{requested:10,generated:questions.length,shortfall:10-questions.length},
    metrics:stats,replay:{stage:v.stage,source_result_sha256:sha256(baseline),source_extraction_frozen:true,full_pipeline_tested:false}};
  fresh('result.json',result);writeFileSync(join(directory,'questions.txt'),interviewGuide(result),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({completed:true,eligible:evidence.filter(e=>e.question_eligible).length,questions:questions.length,cost:stats.estimated_cost_usd}));
}catch(e){fresh('error.json',{message:(e as Error).message,metrics:stats,budget:budget.snapshot()});process.exitCode=1;
  console.error((e as Error).message);
}finally{
  process.off('SIGINT',pause);process.off('SIGTERM',pause);
  try{await renderer?.loadingTask.destroy();fresh('budget-after.json',budget.snapshot());}finally{budget.close();}
}
