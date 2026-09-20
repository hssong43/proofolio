import * as z from 'zod';
import timers from 'node:timers/promises';
import {BudgetError,HttpResponseError,MAX_OUTPUT_TOKENS,SchemaValidationError,schemaErrorSummary,priceFor,requestJson,retryAfterMs} from './llm.ts';
import type {CostBudget,Generate,Metrics,ModelRequest} from './llm.ts';
import {responseSchema} from './schema.ts';
import {SYSTEM} from './prompts.ts';

export const OPENROUTER_URL='https://openrouter.ai/api/v1';
export const OPENROUTER_MODELS={vision:'google/gemini-3.1-pro-preview',skim:'google/gemini-3.8-flash',questions:'anthropic/claude-opus-5'} as const;
export const TRIAL_MODELS={vision:'openai/gpt-6-astra',questions:'anthropic/claude-sonnet-5',review:'anthropic/claude-opus-5'} as const;
type Profile='astra-sonnet-opus';
export const OPENROUTER_UPSTREAM='google-vertex/global';
// Burst mitigation, not a claimed provider quota: upstream 429 has occurred during serial scans.
export const OPENROUTER_REQUEST_INTERVAL_MS=16_000;
export const OPENROUTER_MAX_RATE_LIMIT_RETRIES=2;
export class RateLimitPause extends Error {
  readonly retryAfterMs:number;
  constructor(retryAfterMs:number) { super('OpenRouter 429: 저장한 단계에서 대기 후 이어갑니다.'); this.retryAfterMs=retryAfterMs; }
}
// Explicit model IDs only. Production defaults remain unchanged.
export function openRouterModel(model:string) {
  if(model===TRIAL_MODELS.vision)return {context:1_050_000,rates:{input:20,output:75,cached:2}};
  if(model===TRIAL_MODELS.questions)return {context:1_000_000,rates:{input:2,output:10,cached:.2}};
  if(!Object.values(OPENROUTER_MODELS).includes(model as any))throw new Error('지원하지 않는 OpenRouter 모델입니다.');
  const context=model===OPENROUTER_MODELS.questions?1_000_000:1_048_576;
  const rates=priceFor(model.split('/')[1],new Date(),context);
  // Verified /models/google/gemini-3.8-flash/endpoints on 2026-09-20: Vertex priority is the available ZDR route.
  // This routing/reservation ceiling does not change historical standard-rate accounting or the approved shared budget.
  return {context,rates:model===OPENROUTER_MODELS.skim?{...rates,input:1.35,output:6.75}:rates};
}
export function validateOpenRouterKey(key:unknown):asserts key is string {
  if(typeof key!=='string'||!/^sk-or-[A-Za-z0-9_-]{16,}$/.test(key))
    throw new Error('루트 .env 또는 .env.openrouter에 OPENROUTER_API_KEY를 설정하세요. 키 값은 출력하지 않습니다.');
}
export function buildOpenRouterPayload(request:ModelRequest,providers?:string[],profile?:Profile) {
  const {rates}=openRouterModel(request.model),opus=request.model===OPENROUTER_MODELS.questions;
  const astra=request.model===TRIAL_MODELS.vision,jsonMode=opus||!!profile;
  if(profile){
    const expected=request.kind==='QuestionSet'?TRIAL_MODELS.questions:
      ['CropReadings','Reviews','QuestionReviews'].includes(request.kind)?TRIAL_MODELS.review:TRIAL_MODELS.vision;
    if(request.model!==expected||request.pdf||request.pdf_uri||request.kind==='QuestionSet'&&request.images?.length)
      throw new Error('시험 경로는 Astra 이미지 분석, Sonnet 근거 JSON 질문, Opus 연결 이미지 검수만 허용합니다.');
  }else if(!Object.values(OPENROUTER_MODELS).includes(request.model as any))throw new Error('시험 모델에는 명시적 시험 경로가 필요합니다.');
  if(!profile&&opus&&(request.kind!=='QuestionSet'||request.pdf||request.pdf_uri||request.images?.length))
    throw new Error('OpenRouter Opus에는 질문 생성용 검증 근거 JSON만 전달합니다.');
  if(request.pdf_uri)throw new Error('OpenRouter에는 로컬 PDF 바이트만 전달하세요. 외부 파일 URI는 사용하지 않습니다.');
  if(!request.prompt.trim()||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(request.kind))throw new Error('모델 지시/스키마 이름 오류.');
  const max=request.maxOutputTokens??MAX_OUTPUT_TOKENS;
  if(!Number.isSafeInteger(max)||max<1||max>(opus?MAX_OUTPUT_TOKENS:32768))throw new Error('OpenRouter 최대 출력 토큰 제한 오류.');
  const content:Array<Record<string,unknown>>=[];
  if(request.pdf){
    if(!request.pdf.length||request.pdf.length>12*1024*1024||!Buffer.from(request.pdf.subarray(0,5)).equals(Buffer.from('%PDF-')))
      throw new Error('OpenRouter 인라인 PDF는 12 MiB 이하의 PDF여야 합니다.');
    content.push({type:'file',file:{filename:'portfolio.pdf',file_data:'data:application/pdf;base64,'+Buffer.from(request.pdf).toString('base64')}});
  }
  for(const [label,png]of request.images??[]){
    if(png.length>6*1024*1024||!Buffer.from(png.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      throw new Error('이미지는 6 MiB 이하 PNG여야 합니다.');
    content.push({type:'text',text:label},{type:'image_url',image_url:{url:'data:image/png;base64,'+Buffer.from(png).toString('base64'),...(astra?{detail:'original'}:{})}});
  }
  const wireSchema=responseSchema(request.schema,true);
  // Vertex Opus advertises JSON mode, not native strict schema. Local Zod remains mandatory; no output repair/fallback.
  content.push({type:'text',text:request.prompt+(jsonMode?'\nJSON 객체만 반환한다. 출력은 다음 JSON Schema를 따라야 한다:\n'+JSON.stringify(wireSchema):'')});
  const payload={model:request.model,stream:false,max_tokens:astra?undefined:max,max_completion_tokens:astra?max:undefined,
    messages:[{role:'system',content:SYSTEM},{role:'user',content}],
    response_format:jsonMode?{type:'json_object'}:{type:'json_schema',json_schema:{name:request.kind,strict:true,schema:wireSchema}},
    reasoning:{effort:(request.thinkingLevel??'MEDIUM').toLowerCase(),exclude:true},
    provider:{order:providers?.filter(p=>p===OPENROUTER_UPSTREAM)??[OPENROUTER_UPSTREAM],...(providers?{only:providers}:{}),
      require_parameters:true,allow_fallbacks:true,data_collection:'deny',zdr:true,
      max_price:{prompt:rates.input,completion:rates.output,request:0}},
    ...(request.pdf?{plugins:[{id:'file-parser',pdf:{engine:'native'}}]}:{})};
  if(Buffer.byteLength(JSON.stringify(payload))>19*1024*1024)throw new Error('OpenRouter 요청이 19 MiB를 초과했습니다. PDF/이미지를 분할하세요.');
  return payload;
}
// Trial-only safety allowance, NOT a tokenizer or measured usage. PDF pages must be rendered first.
// UTF-8 bytes plus framing margin; Astra original-detail patches; Claude's documented image cap rounded up.
export function trialInputAllowance(request:ModelRequest) {
  const payload=buildOpenRouterPayload(request,[], 'astra-sonnet-opus');
  const textOnly=JSON.stringify({...payload,messages:payload.messages.map(m=>({...m,content:typeof m.content==='string'?m.content:
    m.content.filter(c=>c.type!=='image_url')}))});
  let tokens=8192+2*Buffer.byteLength(textOnly);
  for(const [,png]of request.images??[]){
    const b=Buffer.from(png);
    if(b.length<24||b.toString('ascii',12,16)!=='IHDR')throw new Error('PNG 크기를 확인할 수 없습니다.');
    const w=b.readUInt32BE(16),h=b.readUInt32BE(20),patches=Math.ceil(w/32)*Math.ceil(h/32);
    if(!w||!h||w>4096||h>4096||patches>30000)throw new Error('시험 이미지 크기 제한 오류.');
    tokens+=request.model===TRIAL_MODELS.vision?Math.ceil(patches*1.2)+256:8192;
  }
  if(tokens+(request.maxOutputTokens??MAX_OUTPUT_TOKENS)>openRouterModel(request.model).context)
    throw new Error('시험 요청의 보수적 입력 한도가 모델 컨텍스트를 초과합니다.');
  return tokens;
}
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function openRouterUsage(raw:unknown) {
  const u=raw as Record<string,any>|null;
  if(!u||!count(u.prompt_tokens)||!count(u.completion_tokens)||!count(u.total_tokens)||
    u.total_tokens!==u.prompt_tokens+u.completion_tokens||!money(u.cost)||u.is_byok===true)
    throw new BudgetError('OpenRouter 실제 토큰/비용을 확인할 수 없습니다. BYOK는 이 경로에서 지원하지 않습니다.');
  const thinking=u.completion_tokens_details?.reasoning_tokens,cached=u.prompt_tokens_details?.cached_tokens;
  if(thinking!=null&&(!count(thinking)||thinking>u.completion_tokens)||cached!=null&&(!count(cached)||cached>u.prompt_tokens))
    throw new BudgetError('OpenRouter 세부 토큰 수가 일관되지 않습니다.');
  return {promptTokenCount:u.prompt_tokens as number,candidatesTokenCount:u.completion_tokens as number,
    totalTokenCount:u.total_tokens as number,thinking_tokens:thinking??null,cached_tokens:cached??null,cost_usd:u.cost as number};
}
export function unconfirmedPartialTokens(raw:Record<string,any>) {
  return raw.usage?.total_tokens===0&&Boolean(raw.choices?.some((c:any)=>
    (raw.error||c.error||c.finish_reason==='error')&&typeof c.message?.content==='string'&&c.message.content.length>0));
}
export function parseOpenRouterResponse(raw:Record<string,any>,schema:z.ZodType) {
  const choice=raw.choices?.[0];
  // HTTP 200 can still carry an upstream error. Never echo its untrusted message or retry it as malformed JSON.
  const error=raw.error??choice?.error;
  if(error)throw new Error(error.code===429
    ?'OpenRouter 상위 공급자의 일시적 요청 제한(429)입니다.'
    :'OpenRouter 상위 공급자 오류로 분석을 중단했습니다.');
  if(raw.choices?.length!==1||choice?.finish_reason!=='stop'||choice.message?.refusal)
    throw new Error('OpenRouter 응답이 거절되거나 완결되지 않았습니다. 출력 한도/모델 접근을 확인하세요.');
  let value:unknown;try{value=JSON.parse(choice.message.content);}catch{throw new SchemaValidationError('OpenRouter 출력이 JSON이 아닙니다.');}
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new SchemaValidationError(schemaErrorSummary(parsed.error,schema));
  return parsed.data;
}
export function openRouterSession(apiKey:string,stats:Metrics,budget:CostBudget|undefined,options:{fetcher?:typeof fetch;
  signal?:AbortSignal;requestIntervalMs?:number;profile?:Profile;initialAttempt?:number;deferRateLimitRetry?:boolean;
  onResponse?:(kind:string,raw:unknown,model:string)=>unknown}={}) {
  validateOpenRouterKey(apiKey);
  const interval=options.requestIntervalMs??OPENROUTER_REQUEST_INTERVAL_MS;
  if(!Number.isFinite(interval)||interval<0)throw new Error('요청 간격이 유효하지 않습니다.');
  const initialAttempt=options.initialAttempt??1;
  if(!Number.isInteger(initialAttempt)||initialAttempt<1||initialAttempt>OPENROUTER_MAX_RATE_LIMIT_RETRIES+1)
    throw new Error('요청 재시도 순번 오류.');
  const headers={Authorization:'Bearer '+apiKey,'Content-Type':'application/json','X-Title':'proofolio'};
  const json=async(path:string,init:RequestInit={}):Promise<Record<string,any>>=>{
    const timeout=AbortSignal.timeout(300_000),[raw,responseHeaders]=await requestJson(OPENROUTER_URL+path,
      {...init,headers,signal:options.signal?AbortSignal.any([options.signal,timeout]):timeout},apiKey,options.fetcher,'OpenRouter');
    return {...raw,_retry_after_ms:retryAfterMs(responseHeaders.get('retry-after'))};
  };
  const verifiedProviders:Record<string,string[]>={};
  let verifiedModels:Promise<void>|undefined;
  const verifyModels=()=>verifiedModels??=(async()=>{
    const [catalog,zdr]=await Promise.all([json('/models'),json('/endpoints/zdr')]);
    if(!Array.isArray(zdr.data))throw new Error('OpenRouter ZDR 허용 경로를 확인할 수 없습니다.');
    for(const id of Object.values(options.profile?TRIAL_MODELS:OPENROUTER_MODELS)){
      const m=catalog.data?.find((m:any)=>m.id===id),{context,rates}=openRouterModel(id),opus=id===OPENROUTER_MODELS.questions;
      const jsonMode=opus||!!options.profile;
      if(!m||m.context_length!==context||!m.supported_parameters?.includes(jsonMode?'response_format':'structured_outputs')||
        !m.supported_parameters?.includes('reasoning')||!m.architecture?.input_modalities?.includes('text')||
        id!==OPENROUTER_MODELS.questions&&!['image','file'].every(v=>m.architecture.input_modalities.includes(v)))
        throw new Error('OpenRouter 모델/컨텍스트/입력/구조화 지원이 변경되었습니다. 생성 전에 다시 확인하세요.');
      const affordable=(p:any)=>p&&typeof p.prompt==='string'&&typeof p.completion==='string'&&p.prompt.trim()&&p.completion.trim()&&
        money(Number(p.prompt))&&money(Number(p.completion))&&Number(p.prompt)*1e6<=rates.input&&Number(p.completion)*1e6<=rates.output&&
        (p.request===undefined||money(Number(p.request))&&Number(p.request)===0)&&
        (p.internal_reasoning===undefined||money(Number(p.internal_reasoning))&&Number(p.internal_reasoning)*1e6<=rates.output);
      if(![m.pricing,...(m.pricing?.overrides??[])].every(affordable))
        throw new BudgetError('OpenRouter 가격이 확인된 상한과 다릅니다. 생성하지 않습니다.');
      const listing=await json('/models/'+id+'/endpoints');
      const required=[id===TRIAL_MODELS.vision?'max_completion_tokens':'max_tokens','reasoning','response_format',...(!jsonMode?['structured_outputs']:[])];
      const eligible=(listing.data?.endpoints??[]).filter((e:any)=>typeof e.tag==='string'&&/^[a-z0-9_./-]+$/.test(e.tag)&&
        e.status===0&&e.context_length>=context&&required.every(p=>e.supported_parameters?.includes(p))&&
        count(e.max_completion_tokens)&&e.max_completion_tokens>=(opus?MAX_OUTPUT_TOKENS:32768)&&
        zdr.data.some((z:any)=>z.model_id===id&&z.tag===e.tag&&z.status===0)&&[e.pricing,...(e.pricing?.overrides??[])].every(affordable));
      if(!eligible.length)throw new Error(`OpenRouter ${id}: 가격/ZDR/출력 형식/용량 조건을 충족하는 공급 경로가 없습니다.`);
      verifiedProviders[id]=[...new Set<string>(eligible.map((e:any)=>e.tag))];
    }
  })();
  const checkAccess=async()=>{
    options.signal?.throwIfAborted();
    const raw=await json('/key'),k=raw.data;
    if(!k||!money(k.usage)||k.limit!==null&&!money(k.limit)||k.limit_remaining!==null&&!money(k.limit_remaining)||
      k.limit_reset!==null&&typeof k.limit_reset!=='string'||typeof k.is_management_key!=='boolean'||typeof k.is_provisioning_key!=='boolean')
      throw new Error('OpenRouter 키 사용 한도를 확인할 수 없습니다.');
    if(k.is_management_key||k.is_provisioning_key)throw new Error('관리 키 대신 사용 한도가 있는 일반 OpenRouter API 키를 사용하세요.');
    await verifyModels();
    return {provider:'openrouter',models:options.profile?TRIAL_MODELS:OPENROUTER_MODELS,upstream:OPENROUTER_UPSTREAM,
      allowed_providers:verifiedProviders,allow_fallbacks:true,max_rate_limit_retries:OPENROUTER_MAX_RATE_LIMIT_RETRIES,
      output_formats:options.profile?{vision:'json_object_with_local_zod',questions:'json_object_with_local_zod',review:'json_object_with_local_zod'}:
        {vision:'json_schema',skim:'json_schema',questions:'json_object_with_local_zod'},key_limit_usd:k.limit as number|null,
      key_remaining_usd:k.limit_remaining as number|null,key_usage_usd:k.usage as number,key_limit_reset:k.limit_reset??null,
      account_balance_usd:null,generation_tested:false,check:'key_models_endpoint_capabilities_prices_and_zdr'};
  };
  // ponytail: one local session at a time; no distributed worker coordination in this CLI trial.
  let queue:Promise<unknown>=Promise.resolve(),halted=false,nextRequestAt=0;
  const generate:Generate=request=>{
    const work=queue.then(async()=>{
      if(halted)throw new Error('이 OpenRouter 세션은 앞선 오류로 중단되었습니다. 자동 재시도하지 않습니다.');
      // Validate the input before any network request; attach checked provider routes after preflight.
      buildOpenRouterPayload(request,undefined,options.profile);
      const {context,rates}=openRouterModel(request.model);
      let retryWait=0;
      for(let attempt=initialAttempt;attempt<=OPENROUTER_MAX_RATE_LIMIT_RETRIES+1;attempt++){
        if(retryWait)await timers.setTimeout(retryWait,undefined,{signal:options.signal});
        if(!budget||budget.blocked||budget.provider!=='openrouter')throw new BudgetError('OpenRouter에는 별도로 승인한 전용 예산 원장이 필요합니다.');
        options.signal?.throwIfAborted();
        const access=await checkAccess();
        const payload=buildOpenRouterPayload(request,verifiedProviders[request.model],options.profile);
        if(access.key_limit_usd===null||access.key_limit_usd<=0||access.key_limit_reset!==null)
          throw new BudgetError('OpenRouter 일반 키에 리셋 없는 유한 사용 한도를 설정하세요. 실제 실행은 별도 로컬 승인 예산으로 제한합니다.');
        // No documented countTokens API: reserve the entire input context plus maximum billed output.
        // This is a conservative reservation, NEVER reported as measured input or estimated actual usage.
        const inputAllowance=options.profile?trialInputAllowance(request):context;
        // Trial uses request size, not the million-token context. 2x input price also covers cache-write premiums.
        const ceiling=(inputAllowance*rates.input*(options.profile?2:1)+(request.maxOutputTokens??MAX_OUTPUT_TOKENS)*rates.output)/1e6;
        if(access.key_remaining_usd===null||ceiling>access.key_remaining_usd)
          throw new BudgetError('OpenRouter 키 잔여 한도가 보수적 최대 비용 예약에 부족합니다.');
        if(nextRequestAt>performance.now())await timers.setTimeout(nextRequestAt-performance.now(),undefined,{signal:options.signal});
        options.signal?.throwIfAborted();
        const id=await budget.reserveUsd(request.model,ceiling);
        if(attempt>initialAttempt)stats.model_calls++;
        nextRequestAt=performance.now()+interval;
        let raw:Record<string,any>,failure:unknown;
        try{raw=await json('/chat/completions',{method:'POST',body:JSON.stringify(payload)});}
        catch(e){
          failure=e;let usage=null;
          // Retain only validated numeric usage, never an upstream error body that may echo source text or credentials.
          try{const u=openRouterUsage(e instanceof HttpResponseError?e.usage:undefined);
            usage={prompt_tokens:u.promptTokenCount,completion_tokens:u.candidatesTokenCount,total_tokens:u.totalTokenCount,cost:u.cost_usd,
              completion_tokens_details:{reasoning_tokens:u.thinking_tokens},prompt_tokens_details:{cached_tokens:u.cached_tokens}};}catch{}
          raw={error:{message:(e instanceof Error?e.message:'OpenRouter 요청 실패').replaceAll(apiKey,'[REDACTED]').slice(0,1000)},
            _http_status:e instanceof HttpResponseError?e.status:null,_request_id:e instanceof HttpResponseError?e.request_id:null,
            _diagnostics:e instanceof HttpResponseError?e.diagnostics:null,
            _retry_after_ms:e instanceof HttpResponseError?e.retry_after_ms:null,
            id:e instanceof HttpResponseError?e.generation_id:null,usage};
        }
        raw._application_http_attempt=attempt;
        const row:Record<string,unknown>={stage:request.kind,model:request.model,provider:'openrouter',
          upstream_provider:raw.provider??null,requested_upstream:OPENROUTER_UPSTREAM,output_format:payload.response_format.type,
          raw_usage:raw.usage??null,reservation_basis:options.profile?'request_bytes_and_image_dimensions_allowance':'maximum_model_context',
          counted_input_tokens:null,reserved_input_tokens:inputAllowance,reserved_cost_usd:ceiling,
          minimum_request_interval_ms:interval,
          allowed_providers:payload.provider.only,allow_fallbacks:true,application_http_attempt:attempt,
          output_tokens_include_thinking:true,provider_retries:null};
        stats.usage.push(row);
        try{
          let usage;try{usage=openRouterUsage(raw.usage);}catch(e){await budget.block(failure?'openrouter_generation_usage_unknown':'openrouter_usage_unavailable');throw failure??e;}
          Object.assign(row,usage,{thinking_tokens_status:usage.thinking_tokens===null?'unconfirmed':'reported',cost_source:'api_usage_cost'});
          const cost=await budget.settleUsd(id,usage.cost_usd);
          stats.estimated_cost_usd+=cost;
          if(unconfirmedPartialTokens(raw))Object.assign(row,{promptTokenCount:null,candidatesTokenCount:null,totalTokenCount:null,
            thinking_tokens:null,cached_tokens:null,token_usage_status:'unconfirmed_partial_error',thinking_tokens_status:'unconfirmed'});
          for(const [metric,key] of [['input_tokens','promptTokenCount'],['output_tokens','candidatesTokenCount'],['total_tokens','totalTokenCount'],
            ['thinking_tokens','thinking_tokens'],['cached_tokens','cached_tokens']] as const){
            const value=row[key] as number|null;
            stats[metric]=stats[metric]===null||value===null?null:stats[metric]+value;
          }
        }finally{await options.onResponse?.(request.kind,raw,request.model);}
        // Retry only explicit 429 after measured usage/cost is settled. Unknown cost keeps the budget blocked.
        const rateLimited=failure instanceof HttpResponseError
          ?failure.status===429||failure.diagnostics.upstream_code===429
          :[raw.error,raw.choices?.[0]?.error].some(e=>e?.code===429||e?.code==='429');
        if(rateLimited){
          if(attempt>OPENROUTER_MAX_RATE_LIMIT_RETRIES)throw new Error('OpenRouter 429: 최대 2회 재시도 후에도 제한이 지속됩니다.');
          retryWait=Math.max(30_000*2**(attempt-1),raw._retry_after_ms??0);
          // Bound interactive waiting without retrying earlier than the provider's requested Retry-After.
          if(retryWait>120_000)throw new Error('OpenRouter 429: Retry-After가 120초를 초과하여 재시도를 중단했습니다.');
          row.retry_wait_ms=retryWait;
          if(options.deferRateLimitRetry)throw new RateLimitPause(retryWait);
          continue;
        }
        if(failure)throw failure;
        if(raw.model!==request.model)throw new Error('요청 모델과 OpenRouter 응답 모델이 다릅니다. 자동 대체를 허용하지 않습니다.');
        return parseOpenRouterResponse(raw,request.schema);
      }
      throw new Error('Unreachable');
    });
    queue=work.catch(e=>{if(!(e instanceof SchemaValidationError))halted=true;});return work;
  };
  return {generate,checkAccess,close:async()=>{await queue;}};
}
