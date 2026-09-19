// Offline first-round export. Reuse the real writer path, never reconstruct its prompt by hand.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {codeHash} from '../src/benchmark.ts';
import {sha256,type AnalysisResult} from '../src/pipeline.ts';
import {openRenderer,renderPage} from '../src/pdf.ts';
import {generateQuestions} from '../src/questions.ts';
import {SYSTEM} from '../src/prompts.ts';
import {responseSchema} from '../src/schema.ts';

const {values:v}=parseArgs({options:{from:{type:'string'},comparison:{type:'string'},id:{type:'string'}}});
if(!v.from||!v.comparison||!v.id||![v.from,v.comparison,v.id].every(s=>/^[a-z0-9-]+$/.test(s)))throw new Error('Require --from RUN --comparison UNIQUE --id DOCUMENT.');
const run=JSON.parse(readFileSync(`output/benchmark/runs/${v.from}/run.json`,'utf8'));
if(run.code_sha256!==codeHash())throw new Error('Cannot export a different frozen writer configuration.');
const saved=readFileSync(`output/benchmark/runs/${v.from}/${v.id}/result.json`),prior=JSON.parse(saved.toString()) as AnalysisResult;
const pdfPath=resolve(`output/benchmark/sources/${v.id}/source.pdf`),bytes=readFileSync(pdfPath);
if(sha256(bytes)!==prior.document.sha256)throw new Error('Source hash mismatch.');
const root=resolve(`output/benchmark/comparisons/${v.comparison}/${v.id}`);
mkdirSync(resolve(root,'..'),{recursive:true,mode:0o700});mkdirSync(root,{mode:0o700});
const fresh=(name:string,value:unknown)=>writeFileSync(resolve(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const renderer=await openRenderer(bytes),images:Array<[string,Uint8Array]>=[],imageFiles:Array<{label:string;path:string;sha256:string}>=[];
try{
  for(const page of prior.analysis_plan.selected_pages){
    const label=`original_page=${page}; context only; use linked anchor boxes`,png=(await renderPage(renderer,page,undefined,1600)).toBuffer('image/png');
    const path=resolve(root,`page-${String(page).padStart(3,'0')}.png`);
    writeFileSync(path,png,{flag:'wx',mode:0o600});images.push([label,png]);imageFiles.push({label,path,sha256:sha256(png)});
  }
  let captured=false;const done=new Error('Captured first writer request without an API call.');
  try{await generateQuestions(prior.evidence,async(kind,schema,args)=>{
    if(kind!=='QuestionSet')throw new Error('Unexpected request.');
    fresh('input.json',{system:SYSTEM,prompt:args.prompt,response_schema:responseSchema(schema),images:imageFiles});captured=true;throw done;
  },{track:prior.track,selectedPoints:prior.analysis_plan.selected_points,contextImages:images,imagesFor:async()=>[]});}
  catch(e){if(e!==done)throw e;}
  if(!captured)fresh('input.json',{status:'no_eligible_sources',system:SYSTEM,images:imageFiles});
  fresh('manifest.json',{id:v.id,from:v.from,comparison:v.comparison,track:prior.track,source_pdf:pdfPath,source_pdf_sha256:sha256(bytes),
    source_result_sha256:sha256(saved),code_sha256:codeHash(),selected_pages:prior.analysis_plan.selected_pages,
    input_sha256:sha256(readFileSync(resolve(root,'input.json'))),created_at:new Date().toISOString(),
    scope:'first QuestionSet draft, identical eligible evidence and rendered page bytes; not end-to-end PDF extraction',
    blinding:'Luna writer must not read Gemini outputs, audits, metrics or gold. Parent assesses both raw first drafts separately.',
    limitations:['Codex system/tool wrapper differs from Gemini REST; image delivery may be resized by the client.',
      'Luna subagent usage and billing are unknown unless actual provider/session counters can be attributed. Never estimate tokens from text length.']});
  console.log(root);
}finally{await renderer.loadingTask.destroy();}
