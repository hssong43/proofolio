import * as z from 'zod';
import timers from 'node:timers/promises';
import {Budget,BudgetError,HttpResponseError,MAX_OUTPUT_TOKENS,SchemaValidationError,priceFor,requestJson,retryAfterMs} from './llm.ts';
import type {Generate,Metrics,ModelRequest} from './llm.ts';
import {responseSchema} from './schema.ts';
import {SYSTEM} from './prompts.ts';

export const OPENROUTER_URL='https://openrouter.ai/api/v1';
export const OPENROUTER_MODELS={vision:'google/gemini-3.1-pro-preview',skim:'google/gemini-3.8-flash',questions:'anthropic/claude-opus-5'} as const;
export const OPENROUTER_UPSTREAM='google-vertex/global';
// Burst mitigation, not a claimed provider quota: upstream 429 has occurred during serial scans.
export const OPENROUTER_REQUEST_INTERVAL_MS=16_000;
export const OPENROUTER_MAX_RATE_LIMIT_RETRIES=2;
// Only the three explicitly checked models. No auto-router, model fallback, tools or paid OCR.
export function openRouterModel(model:string) {
  if(!Object.values(OPENROUTER_MODELS).includes(model as any))throw new Error('지원하지 않는 OpenRouter 모델입니다.');
  const context=model===OPENROUTER_MODELS.questions?1_000_000:1_048_576;
  const rates=priceFor(model.split('/')[1],new Date(),context);
  return {context,rates};
}
export function validateOpenRouterKey(key:unknown):asserts key is string {
  if(typeof key!=='string'||!/^sk-or-[A-Za-z0-9_-]{16,}$/.test(key))
    throw new Error('루트 .env 또는 .env.openrouter에 OPENROUTER_API_KEY를 설정하세요. 키 값은 출력하지 않습니다.');
}
export function buildOpenRouterPayload(request:ModelRequest,providers?:string[]) {
  const {rates}=openRouterModel(request.model),opus=request.model===OPENROUTER_MODELS.questions;
  if(opus&&(request.kind!=='QuestionSet'||request.pdf||request.pdf_uri||request.images?.length))
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
    content.push({type:'text',text:label},{type:'image_url',image_url:{url:'data:image/png;base64,'+Buffer.from(png).toString('base64')}});
  }
  const wireSchema=responseSchema(request.schema,true);
  // Vertex Opus advertises JSON mode, not native strict schema. Local Zod remains mandatory; no output repair/fallback.
  content.push({type:'text',text:request.prompt+(opus?'\nJSON 객체만 반환한다. 출력은 다음 JSON Schema를 따라야 한다:\n'+JSON.stringify(wireSchema):'')});
  const payload={model:request.model,stream:false,max_tokens:max,
    messages:[{role:'system',content:SYSTEM},{role:'user',content}],
    response_format:opus?{type:'json_object'}:{type:'json_schema',json_schema:{name:request.kind,strict:true,schema:wireSchema}},
    reasoning:{effort:(request.thinkingLevel??'MEDIUM').toLowerCase(),exclude:true},
    provider:{order:providers?.filter(p=>p===OPENROUTER_UPSTREAM)??[OPENROUTER_UPSTREAM],...(providers?{only:providers}:{}),
      require_parameters:true,allow_fallbacks:true,data_collection:'deny',zdr:true,
      max_price:{prompt:rates.input,completion:rates.output,request:0}},
    ...(request.pdf?{plugins:[{id:'file-parser',pdf:{engine:'native'}}]}:{})};
  if(Buffer.byteLength(JSON.stringify(payload))>19*1024*1024)throw new Error('OpenRouter 요청이 19 MiB를 초과했습니다. PDF/이미지를 분할하세요.');
  return payload;
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
  if(!parsed.success)throw new SchemaValidationError('OpenRouter 출력 필드/스키마 오류. 원본 값은 출력하지 않습니다.');
  return parsed.data;
}
export function openRouterSession(apiKey:string,stats:Metrics,budget:Budget|undefined,options:{fetcher?:typeof fetch;
  signal?:AbortSignal;requestIntervalMs?:number;onResponse?:(kind:string,raw:unknown,model:string)=>void}={}) {
  validateOpenRouterKey(apiKey);
  const interval=options.requestIntervalMs??OPENROUTER_REQUEST_INTERVAL_MS;
  if(!Number.isFinite(interval)||interval<0)throw new Error('요청 간격이 유효하지 않습니다.');
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
    for(const id of Object.values(OPENROUTER_MODELS)){
      const m=catalog.data?.find((m:any)=>m.id===id),{context,rates}=openRouterModel(id),opus=id===OPENROUTER_MODELS.questions;
      if(!m||m.context_length!==context||!m.supported_parameters?.includes(opus?'response_format':'structured_outputs')||
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
      const required=['max_tokens','reasoning','response_format',...(!opus?['structured_outputs']:[])];
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
    return {provider:'openrouter',models:OPENROUTER_MODELS,upstream:OPENROUTER_UPSTREAM,
      allowed_providers:verifiedProviders,allow_fallbacks:true,max_rate_limit_retries:OPENROUTER_MAX_RATE_LIMIT_RETRIES,
      output_formats:{vision:'json_schema',skim:'json_schema',questions:'json_object_with_local_zod'},key_limit_usd:k.limit as number|null,
      key_remaining_usd:k.limit_remaining as number|null,key_usage_usd:k.usage as number,key_limit_reset:k.limit_reset??null,
      account_balance_usd:null,generation_tested:false,check:'key_models_endpoint_capabilities_prices_and_zdr'};
  };
  // ponytail: serialize this local session to avoid overlapping worst-context reservations; add a real preflight tokenizer before relaxing this.
  let queue:Promise<unknown>=Promise.resolve(),halted=false,nextRequestAt=0;
  const generate:Generate=request=>{
    const work=queue.then(async()=>{
      if(halted)throw new Error('이 OpenRouter 세션은 앞선 오류로 중단되었습니다. 자동 재시도하지 않습니다.');
      // Validate the input before any network request; attach checked provider routes after preflight.
      buildOpenRouterPayload(request);
      const {context,rates}=openRouterModel(request.model);
      let retryWait=0;
      for(let attempt=1;attempt<=OPENROUTER_MAX_RATE_LIMIT_RETRIES+1;attempt++){
        if(retryWait)await timers.setTimeout(retryWait,undefined,{signal:options.signal});
        if(!budget||budget.blocked||budget.provider!=='openrouter')throw new BudgetError('OpenRouter에는 별도로 승인한 전용 예산 원장이 필요합니다.');
        options.signal?.throwIfAborted();
        const access=await checkAccess();
        const payload=buildOpenRouterPayload(request,verifiedProviders[request.model]);
        if(access.key_limit_usd===null||access.key_limit_usd<=0||access.key_limit_reset!==null)
          throw new BudgetError('OpenRouter 일반 키에 리셋 없는 유한 사용 한도를 설정하세요. 실제 실행은 별도 로컬 승인 예산으로 제한합니다.');
        // No documented countTokens API: reserve the entire input context plus maximum billed output.
        // This is a conservative reservation, NEVER reported as measured input or estimated actual usage.
        const ceiling=(context*rates.input+payload.max_tokens*rates.output)/1e6;
        if(access.key_remaining_usd===null||ceiling>access.key_remaining_usd)
          throw new BudgetError('OpenRouter 키 잔여 한도가 보수적 최대 비용 예약에 부족합니다.');
        if(nextRequestAt>performance.now())await timers.setTimeout(nextRequestAt-performance.now(),undefined,{signal:options.signal});
        options.signal?.throwIfAborted();
        const id=budget.reserveUsd(request.model,ceiling);
        if(attempt>1)stats.model_calls++;
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
          raw_usage:raw.usage??null,reservation_basis:'maximum_model_context',
          counted_input_tokens:null,reserved_input_tokens:context,reserved_cost_usd:ceiling,
          minimum_request_interval_ms:interval,
          allowed_providers:payload.provider.only,allow_fallbacks:true,application_http_attempt:attempt,
          output_tokens_include_thinking:true,provider_retries:null};
        stats.usage.push(row);
        try{
          let usage;try{usage=openRouterUsage(raw.usage);}catch(e){budget.block(failure?'openrouter_generation_usage_unknown':'openrouter_usage_unavailable');throw failure??e;}
          Object.assign(row,usage,{thinking_tokens_status:usage.thinking_tokens===null?'unconfirmed':'reported',cost_source:'api_usage_cost'});
          const cost=budget.settleUsd(id,usage.cost_usd);
          stats.estimated_cost_usd+=cost;stats.input_tokens+=usage.promptTokenCount;stats.output_tokens+=usage.candidatesTokenCount;
          stats.total_tokens+=usage.totalTokenCount;stats.cached_tokens+=usage.cached_tokens??0;
          if(stats.thinking_tokens!==null)stats.thinking_tokens=usage.thinking_tokens===null?null:stats.thinking_tokens+usage.thinking_tokens;
        }finally{options.onResponse?.(request.kind,raw,request.model);}
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
