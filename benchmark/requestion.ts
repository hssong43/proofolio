// Question-stage regression only. Reuse immutable source evidence, never count this as a fresh PDF analysis.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {codeHash,Corpus} from '../src/benchmark.ts';
import {loadEnv} from '../src/cli.ts';
import {Budget,fileSession,freshMetrics,SchemaValidationError} from '../src/gemini.ts';
import {sha256,localEvidenceChecks,type AnalysisResult} from '../src/pipeline.ts';
import type {Evidence} from '../src/schema.ts';
import {openRenderer,renderPage,textSpans,numericQuoteIssue} from '../src/pdf.ts';
import {generateQuestions,questionQuality,interviewGuide,type Request} from '../src/questions.ts';

const {values:v}=parseArgs({options:{from:{type:'string'},run:{type:'string'},ids:{type:'string'}}});
if(!v.from||!v.run||![v.from,v.run].every(s=>/^[a-z0-9-]+$/.test(s)))throw new Error('Unique --run and existing --from required.');
const corpus=Corpus.parse(JSON.parse(readFileSync('benchmark/corpus.json','utf8')));
const ids=v.ids?.split(',')??['d-asad','m-vishv','d-soumyashree'];
if(!ids.length||ids.some(id=>!corpus.some(s=>s.id===id))||new Set(ids).size!==ids.length)throw new Error('Invalid corpus IDs.');
const root=`output/benchmark/runs/${v.run}`,fresh=(p:string,data:unknown)=>writeFileSync(p,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
mkdirSync(root,{mode:0o700});loadEnv('.env');
const budget=new Budget('output/benchmark/api-budget.jsonl',10),model='gemini-3.8-flash';
const controller=new AbortController(),pause=()=>controller.abort(new Error('사용자 중단: 진행 요청 정산 후 종료'));
process.on('SIGINT',pause);process.on('SIGTERM',pause);
try{
  budget.capAdditionalKrw(10000,2000);
  fresh(root+'/run.json',{mode:'question_stage_only',from:v.from,documents:ids,code_sha256:codeHash(),orchestration_sha256:sha256(readFileSync(new URL(import.meta.url))),model,started_at:new Date().toISOString(),budget_before:budget.snapshot()});
  for(const id of ids){
    controller.signal.throwIfAborted();
    const dir=root+'/'+id;mkdirSync(dir,{mode:0o700});
    const saved=readFileSync(`output/benchmark/runs/${v.from}/${id}/result.json`),prior=JSON.parse(saved.toString()) as AnalysisResult;
    const bytes=readFileSync(`output/benchmark/sources/${id}/source.pdf`);
    if(sha256(bytes)!==prior.document.sha256||sha256(bytes)!==corpus.find(s=>s.id===id)!.sha256)throw new Error('Source mismatch.');
    const renderer=await openRenderer(bytes),stats=freshMetrics(),started=performance.now();let raw=0;
    const session=fileSession(process.env.GEMINI_API_KEY!,stats,budget,{onResponse:(kind,response)=>fresh(`${dir}/raw-${String(++raw).padStart(3,'0')}-${kind}.json`,response)});
    try{
      const evidence=structuredClone(prior.evidence),rejected=[];
      const spans=new Map(await Promise.all(prior.analysis_plan.selected_pages.map(async page=>[page,await textSpans(renderer,page)] as const)));
      for(const e of evidence){const issues=localEvidenceChecks(e as Evidence);
        for(const a of e.anchors)if(a.quote){const issue=numericQuoteIssue(a.quote,a.box,spans.get(a.page)??[]);if(issue)issues.push(issue);}
        if(issues.length){e.question_eligible=false;rejected.push({evidence_id:e.id,reasons:issues});}
      }
      const request:Request=async(kind,schema,args,check)=>{
        for(let attempt=1;attempt<=2;attempt++){
          controller.signal.throwIfAborted();
          stats.model_calls++;const t=performance.now();
          try{const raw=await session.generate({kind,schema,model,thinkingLevel:kind==='QuestionReviews'?'MEDIUM':'LOW',...args});
            try{const result=schema.parse(raw);check?.(result);return result;}catch{throw new SchemaValidationError('출력 필드/스키마 또는 교차 참조 오류.');}
          }catch(e){if(!(e instanceof SchemaValidationError)||attempt===2)throw e;
            args={...args,prompt:args.prompt+'\n이전 형식 오류: '+e.message};
          }finally{stats.stages.push({stage:kind,attempt,elapsed_ms:Math.round(performance.now()-t)});}
        }throw new Error('Unreachable');
      };
      const cache=new Map<string,Buffer>();
      const generated=await generateQuestions(evidence,request,{track:prior.track,selectedPoints:prior.analysis_plan.selected_points,imagesFor:async candidates=>{
        const images:Array<[string,Uint8Array]>=[];
        for(const c of candidates)for(const a of c.source.anchors){const key=JSON.stringify([a.page,a.box]);
          if(!cache.has(key))cache.set(key,(await renderPage(renderer,a.page,a.box)).toBuffer('image/png'));
          images.push([`question_id=${c.question_id}; region_id=${a.region_id}`,cache.get(key)!]);}return images;
      }});
      stats.total_ms=Math.round(performance.now()-started);
      const quality=questionQuality(generated.cards,prior.analysis_plan.selected_points.map(p=>p.id));
      const result={schema_version:'0.8',mode:'question_stage_only',source_run:v.from,source_result_sha256:sha256(saved),
        track:prior.track,document:prior.document,analysis_plan:prior.analysis_plan,evidence,visual_inventory:prior.visual_inventory,
        inherited_analysis_estimated_cost_usd:prior.metrics.estimated_cost_usd,quality,
        status:!generated.cards.length?'insufficient_evidence':quality.status==='ready'?'evidence_ready':'needs_review',
        questions:generated.cards,question_checks:generated.checks,rejected_candidates:rejected,metrics:stats};
      fresh(dir+'/result.json',result);writeFileSync(dir+'/questions.txt',interviewGuide(result),{flag:'wx',mode:0o600});
      console.log(JSON.stringify({id,mode:result.mode,status:result.status,questions:result.questions.length,cost:stats.estimated_cost_usd}));
    }finally{await session.close();await renderer.loadingTask.destroy();}
  }
}finally{process.off('SIGINT',pause);process.off('SIGTERM',pause);try{fresh(root+'/budget-after.json',budget.snapshot());}finally{budget.close();}}
