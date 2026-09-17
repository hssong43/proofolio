import {readFileSync,existsSync,statSync} from 'node:fs';
import {open,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs,parseEnv} from 'node:util';
import {analyzePdf} from './pipeline.ts';
import type {AnalyzeOptions,AnalysisResult} from './pipeline.ts';
import {Budget} from './gemini.ts';
import {MAX_PDF_BYTES,savePreviews} from './pdf.ts';
import {Track} from './schema.ts';
import {interviewGuide} from './questions.ts';

export function loadEnv(path:string,env:NodeJS.ProcessEnv=process.env) {
  if(!existsSync(path))return;
  for(const [i,line] of readFileSync(path,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
    const match=line.trim().match(/^(?:export\s+)?(GEMINI_API_KEY|GEMINI_MODEL)\s*=\s*(.*)$/);if(!match)continue;
    const value=match[2];
    if(value.startsWith('"')&&!/^"[^"\r\n]*"\s*(?:#.*)?$/.test(value)
      ||value.startsWith("'")&&!/^'[^'\r\n]*'\s*(?:#.*)?$/.test(value)
      ||!/^['"]/.test(value)&&!/^\S*(?:\s+#.*)?$/.test(value))throw new Error(`.env ${i+1}행 형식 오류. 값을 출력하지 않습니다.`);
    const parsed=parseEnv(line);if(env[match[1]]===undefined)env[match[1]]=parsed[match[1]]??'';
  }
}
export async function readPdfFile(path:string) {
  const file=await open(path,'r');
  try{const buffer=Buffer.alloc(MAX_PDF_BYTES+1);let size=0;
    while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}
    if(size>MAX_PDF_BYTES)throw new Error('PDF가 50 MB를 초과했습니다.');return buffer.subarray(0,size);
  }finally{await file.close();}
}
export async function writeNew(path:string,data:string|Uint8Array){await writeFile(path,data,{flag:'wx',mode:0o600});}
export function checkDestinations(paths:Array<string|undefined>) {
  const selected=paths.filter((p):p is string=>p!==undefined).map(p=>resolve(p));
  if(new Set(selected).size!==selected.length)throw new Error('출력 경로가 중복됩니다.');
  for(const path of selected){if(existsSync(path))throw new Error('출력 경로가 이미 존재합니다. 새 경로를 지정하세요.');
    if(!existsSync(dirname(path))||!statSync(dirname(path)).isDirectory())throw new Error('출력 상위 폴더가 없습니다.');}
}
export async function runCli(argv=process.argv.slice(2),deps:{analyze?:typeof analyzePdf;env?:NodeJS.ProcessEnv;
  envPath?:string;signal?:AbortSignal;stdout?:(text:string)=>void;stderr?:(text:string)=>void}={}) {
  const stdout=deps.stdout??(s=>process.stdout.write(s+'\n')),stderr=deps.stderr??(s=>process.stderr.write(s+'\n'));
  let budget:Budget|undefined;
  try{
    const {values:v,positionals}=parseArgs({args:argv,allowPositionals:true,options:{track:{type:'string'},model:{type:'string'},
      'skim-model':{type:'string'},'review-model':{type:'string'},scope:{type:'string',default:'focused'},'page-budget':{type:'string',default:'5'},
      events:{type:'boolean'},output:{type:'string'},'guide-output':{type:'string'},'inspect-only':{type:'boolean'},'preview-dir':{type:'string'},
      'budget-ledger':{type:'string',default:'output/api-budget.jsonl'},'max-cost-usd':{type:'string',default:'10'},
      'additional-budget-krw':{type:'string'},'krw-per-usd':{type:'string',default:'2000'},help:{type:'boolean'}}});
    if(v.help){stdout('npm run analyze -- FILE.pdf --track design|marketing [--output result.json] [--guide-output questions.txt] [--events] [--preview-dir NEW_DIR]\n기본: focused 5페이지, 누적 예산 10달러. --budget-ledger로 같은 예산 원장을 재사용하세요.');return 0;}
    if(positionals.length!==1)throw new Error('PDF 경로 한 개가 필요합니다.');
    const env=deps.env??process.env;loadEnv(deps.envPath??resolve(dirname(fileURLToPath(import.meta.url)),'../.env'),env);
    const track=Track.parse(v.track);if(v.scope!=='focused'&&v.scope!=='full')throw new Error('scope은 focused/full입니다.');
    checkDestinations([v.output,v['guide-output'],v['preview-dir']]);
    if(v['inspect-only']&&v['guide-output'])throw new Error('이미지 구분 모드에서는 질문 가이드를 만들지 않습니다.');
    const bytes=await readPdfFile(positionals[0]);
    budget=new Budget(v['budget-ledger'],Number(v['max-cost-usd']));
    if(v['additional-budget-krw'])budget.capAdditionalKrw(Number(v['additional-budget-krw']),Number(v['krw-per-usd']));
    const options:AnalyzeOptions={track,apiKey:env.GEMINI_API_KEY,model:v.model??env.GEMINI_MODEL??'gemini-3.8-flash',skimModel:v['skim-model'],reviewModel:v['review-model'],
      scope:v.scope,pageBudget:Number(v['page-budget']),inspectOnly:v['inspect-only'],budget,signal:deps.signal,
      onEvent:v.events?event=>stdout(JSON.stringify(event)):undefined};
    const result:AnalysisResult=await(deps.analyze??analyzePdf)(bytes,options);
    if(v['preview-dir'])await savePreviews(bytes,result.visual_inventory,v['preview-dir']);
    if(v.output)await writeNew(v.output,JSON.stringify(result,null,2)+'\n');
    if(v['guide-output'])await writeNew(v['guide-output'],interviewGuide(result));
    if(!v.output&&!v.events)stdout(JSON.stringify(result,null,2));
    stderr(`완료. 추정 API 비용 $${result.metrics.estimated_cost_usd.toFixed(6)}; 누적 $${budget.spent.toFixed(6)}`);return 0;
  }catch(e){stderr('분석 실패: '+(e instanceof Error?e.message:'알 수 없는 오류'));return 1;}
  finally{budget?.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const controller=new AbortController(),pause=()=>controller.abort(new Error('사용자 중단: 전송된 요청만 정산하고 종료합니다.'));
  process.on('SIGINT',pause);process.on('SIGTERM',pause);
  try{process.exitCode=await runCli(undefined,{signal:controller.signal});}
  finally{process.off('SIGINT',pause);process.off('SIGTERM',pause);}
}
