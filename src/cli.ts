import {existsSync,statSync} from 'node:fs';
import {open,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {analyzePdf} from './pipeline.ts';
import type {AnalyzeOptions,AnalysisResult} from './pipeline.ts';
import {Budget} from './llm.ts';
import {loadEnv,loadRuntimeEnv,executionBudget} from './env.ts';
export {loadEnv} from './env.ts';
import {OPENROUTER_MODELS,validateOpenRouterKey} from './openrouter.ts';
import {MAX_PDF_BYTES,savePreviews} from './pdf.ts';
import {Track} from './schema.ts';
import {interviewGuide,DEFAULT_MAX_QUESTIONS} from './questions.ts';

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
    const {values:v,positionals}=parseArgs({args:argv,allowPositionals:true,options:{track:{type:'string'},model:{type:'string'},provider:{type:'string',default:'openrouter'},
      'skim-model':{type:'string'},'review-model':{type:'string'},'question-model':{type:'string'},
      scope:{type:'string',default:'focused'},'page-budget':{type:'string',default:'5'},'max-questions':{type:'string',default:String(DEFAULT_MAX_QUESTIONS)},
      events:{type:'boolean'},output:{type:'string'},'guide-output':{type:'string'},'inspect-only':{type:'boolean'},'preview-dir':{type:'string'},
      'budget-ledger':{type:'string'},'max-cost-usd':{type:'string'},help:{type:'boolean'}}});
    if(v.help){stdout('npm run analyze -- FILE.pdf --track design|marketing --max-cost-usd APPROVED_LIMIT [--output result.json] [--guide-output questions.txt] [--events] [--preview-dir NEW_DIR] [--max-questions 1..5]\nOpenRouter 전용: Gemini 비전 → Opus 질문 → Gemini 원본 대조. 기본 focused 5페이지·최대 5문항.\n승인한 누적 한도(0 초과 10달러 이하)는 --max-cost-usd 또는 PROOFOLIO_MAX_COST_USD로 지정하세요. CLI·웹·벤치마크는 같은 원장을 재사용합니다.\n키/모델 무료 확인: npm run check:openrouter');return 0;}
    if(positionals.length!==1)throw new Error('PDF 경로 한 개가 필요합니다.');
    if(v.provider!=='openrouter')throw new Error('OpenRouter만 지원합니다. Gemini 직접 API/GCP 호출 경로는 제거되었습니다.');
    const env=deps.env??process.env,root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
    if(deps.envPath)loadEnv(deps.envPath,env);else loadRuntimeEnv(root,env);
    validateOpenRouterKey(env.OPENROUTER_API_KEY);
    const config=executionBudget(root,env,{limit:v['max-cost-usd'],ledger:v['budget-ledger']});
    const track=Track.parse(v.track),maxQuestions=Number(v['max-questions']);
    if(v.scope!=='focused'&&v.scope!=='full')throw new Error('scope은 focused/full입니다.');
    if(!Number.isInteger(maxQuestions)||maxQuestions<1||maxQuestions>DEFAULT_MAX_QUESTIONS)throw new Error('최대 질문 수는 1~5입니다.');
    checkDestinations([v.output,v['guide-output'],v['preview-dir']]);
    if(v['inspect-only']&&v['guide-output'])throw new Error('이미지 구분 모드에서는 질문 가이드를 만들지 않습니다.');
    const bytes=await readPdfFile(positionals[0]);
    budget=new Budget(config.ledger,config.limit,'openrouter');
    const options:AnalyzeOptions={track,provider:'openrouter',apiKey:env.OPENROUTER_API_KEY,
      model:v.model??env.OPENROUTER_MODEL??OPENROUTER_MODELS.vision,
      skimModel:v['skim-model']??env.OPENROUTER_SKIM_MODEL??OPENROUTER_MODELS.skim,
      reviewModel:v['review-model']??env.OPENROUTER_REVIEW_MODEL??OPENROUTER_MODELS.vision,
      questionModel:v['question-model']??env.OPENROUTER_QUESTION_MODEL??OPENROUTER_MODELS.questions,
      scope:v.scope,pageBudget:Number(v['page-budget']),maxQuestions,inspectOnly:v['inspect-only'],budget,signal:deps.signal,
      onEvent:v.events?event=>stdout(JSON.stringify(event)):undefined};
    const result:AnalysisResult=await(deps.analyze??analyzePdf)(bytes,options);
    if(v['preview-dir'])await savePreviews(bytes,result.visual_inventory,v['preview-dir']);
    if(v.output)await writeNew(v.output,JSON.stringify(result,null,2)+'\n');
    if(v['guide-output'])await writeNew(v['guide-output'],interviewGuide(result));
    if(!v.output&&!v.events)stdout(JSON.stringify(result,null,2));
    stderr(`완료. 보고된 API 비용 $${result.metrics.estimated_cost_usd.toFixed(6)}; OpenRouter 누적 $${budget.spent.toFixed(6)}`);return 0;
  }catch(e){stderr('분석 실패: '+(e instanceof Error?e.message:'알 수 없는 오류'));return 1;}
  finally{budget?.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const controller=new AbortController(),pause=()=>controller.abort(new Error('사용자 중단: 전송된 요청만 정산하고 종료합니다.'));
  process.on('SIGINT',pause);process.on('SIGTERM',pause);
  try{process.exitCode=await runCli(undefined,{signal:controller.signal});}
  finally{process.off('SIGINT',pause);process.off('SIGTERM',pause);}
}
