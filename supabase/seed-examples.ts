// Explicit operator command. Reuses saved results; never calls a model or edits old artifacts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { dbRequest, syncRun, type StoredRun } from '../web/lib/server/database.ts';
import { toClientResult } from '../web/lib/server/runner.ts';
import { storageClient, PRIVATE_BUCKET, storeSources, storeCodeSources } from '../web/lib/server/assets.ts';

const {values}=parseArgs({options:{'coding-result':{type:'string'},'coding-input':{type:'string'}}});
const sha=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const uuid=(value:string)=>{const hex=sha(value);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;};
const owner=sha('proofolio:private-example-library:v1');
const storage=storageClient().storage;
await dbRequest('/rest/v1/proofolio_examples?select=slug&limit=0');
const found=await storage.getBucket(PRIVATE_BUCKET);
if(found.error){
  if(!['400','404'].includes(String(found.error.statusCode)))throw new Error('Storage 상태를 확인하지 못했어요.');
  const created=await storage.createBucket(PRIVATE_BUCKET,{public:false,fileSizeLimit:50_000_000,allowedMimeTypes:['application/pdf','image/png','application/json','text/plain']});
  if(created.error)throw new Error('비공개 Storage 생성 실패');
}else if(found.data.public)throw new Error('예제 원문 버킷이 공개 상태예요. 가져오기를 중단합니다.');

const sources=[{slug:'design',id:'d-shuu',title:'디자인 포트폴리오'},{slug:'marketing',id:'m-damyul',title:'마케팅 포트폴리오'}];
for(const source of sources){
  const root=resolve('output/benchmark/runs/gemini-broad-20260920-02',source.id);
  const raw=JSON.parse(readFileSync(resolve(root,'result.json'),'utf8'));
  const bytes=readFileSync(resolve('output/benchmark/sources',source.id,'source.pdf'));
  const metadata=JSON.parse(readFileSync(resolve('output/benchmark/sources',source.id,'metadata.json'),'utf8'));
  if(sha(bytes)!==metadata.sha256)throw new Error('기존 PDF 해시 불일치');
  await seed(source.slug,source.title,bytes,toClientResult(raw),raw,false);
}
if(values['coding-result']||values['coding-input']){
  if(!values['coding-result']||!values['coding-input'])throw new Error('코딩 결과와 입력 경로를 함께 지정해주세요.');
  const raw=JSON.parse(readFileSync(values['coding-result'],'utf8')),bytes=readFileSync(values['coding-input']);
  await seed('coding','공개 코드 구조 설명',bytes,raw.client_result,raw,true);
}
async function seed(slug:string,title:string,bytes:Uint8Array,result:StoredRun['result'],raw:Record<string,any>,coding:boolean){
  if(!result||result.questions.length<6||result.questions.length>10)throw new Error('예제는 기존 자동 질문 6~10개가 필요해요. 질문을 새로 만들거나 채우지 않습니다.');
  const id=uuid(`proofolio:example:v1:${slug}:${sha(bytes)}:${sha(JSON.stringify(result.questions))}`);
  const existing=await dbRequest(`/rest/v1/proofolio_runs?id=eq.${id}&select=id,result,pdf_sha256&limit=1`);
  if(existing.length){
    if(existing[0].pdf_sha256!==sha(bytes)||!isDeepStrictEqual(existing[0].result?.questions,result.questions))throw new Error('기존 예제와 충돌해 덮어쓰지 않았어요.');
    result=existing[0].result;
  }else{
    result.sourceAssets=coding?await storeCodeSources(owner,id,JSON.parse(Buffer.from(bytes).toString('utf8')).files,raw):await storeSources(owner,id,bytes,result,raw);
    await syncRun({runId:id,userId:owner,storage:'supabase',track:slug as StoredRun['track'],fileName:title+(coding?'':'.pdf'),
      pdfSha256:sha(bytes),requestedQuestions:10,state:'complete',stage:3,startedAt:'2026-09-20T00:00:00Z',finishedAt:'2026-09-20T00:00:01Z',
      result,metrics:raw.metrics,schemaVersion:raw.schema_version});
  }
  const {sourceAssets:_private,...publicResult}=result!;
  const notice=coding?'코드를 읽어 생성한 예제입니다. 코드 실행·보안 검사·질문 의미 검수는 하지 않았습니다.':
    '기존 자동 생성 결과를 그대로 재사용합니다. 검토 권장 항목이 남아 있으며 원본 포트폴리오는 공개하지 않습니다.';
  const old=await dbRequest(`/rest/v1/proofolio_examples?slug=eq.${slug}&select=source_run_id&limit=1`);
  if(old.length&&old[0].source_run_id!==id)throw new Error('다른 예제가 이미 등록돼 있어 덮어쓰지 않았어요.');
  if(!old.length)await dbRequest('/rest/v1/proofolio_examples',{method:'POST',body:JSON.stringify({slug,title,source_run_id:id,result:publicResult,notice})});
  console.log(JSON.stringify({slug,questions:result!.questions.length,private_assets:result!.sourceAssets?.length??0,models_called:0,stored:true}));
}
