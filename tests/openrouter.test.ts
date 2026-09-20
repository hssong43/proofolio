import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import timers from 'node:timers/promises';
import * as z from 'zod';
import {Budget,BudgetError,HttpResponseError,SchemaValidationError,freshMetrics} from '../src/llm.ts';
import {OPENROUTER_MODELS as MODELS,TRIAL_MODELS,trialInputAllowance,OPENROUTER_UPSTREAM,OPENROUTER_URL,buildOpenRouterPayload,openRouterModel,openRouterSession,openRouterUsage,parseOpenRouterResponse,validateOpenRouterKey} from '../src/openrouter.ts';
import {loadEnv,runCli} from '../src/cli.ts';
import {modelRequest} from '../src/questions.ts';

const key='sk-or-v1-private-fixture-never-log',schema=z.strictObject({value:z.string().min(1)});
const request={model:MODELS.questions,kind:'QuestionSet',prompt:'검증된 근거 JSON만 이용한다.',schema};
const makeBudget=(limit=10)=>new Budget(join(mkdtempSync(join(tmpdir(),'proofolio-router-')),'ledger.jsonl'),limit,'openrouter');
const response=()=>({model:MODELS.questions,provider:'Google',choices:[{finish_reason:'stop',message:{content:'{"value":"question"}'}}],
  usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130,cost:.00125,
    prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:10}}});
function transport(mode='ok',models:string[]=Object.values(MODELS)){
  const seen:Array<{url:string;body:any}>=[];let generations=0;
  const endpoint=(id:string)=>{const {context,rates}=openRouterModel(id);return {
    model_id:id,tag:mode==='wrong_upstream'?'google-ai-studio':OPENROUTER_UPSTREAM,status:mode==='endpoint_unavailable'?-1:0,context_length:context,
    max_completion_tokens:mode==='endpoint_too_small'?100:65536,
    supported_parameters:['max_tokens','max_completion_tokens','reasoning',...(mode==='endpoint_no_json'?[]:['response_format']),
      ...(id!==MODELS.questions&&mode!=='endpoint_no_schema'?['structured_outputs']:[])],
    pricing:{prompt:mode==='endpoint_invalid_price'?'':String(rates.input/1e6),completion:String(rates.output/1e6),
      ...(mode==='endpoint_expensive'?{overrides:[{prompt:'1',completion:'1'}]}:{}),...(mode==='endpoint_request_fee'?{request:'0.01'}:{})}};};
  const endpoints=(id:string)=>{
    const e=endpoint(id);
    if(mode==='flash_priority'&&id===MODELS.skim)return [{...e,status:-2},
      {...e,tag:OPENROUTER_UPSTREAM+'/priority',pricing:{prompt:'0.00000135',completion:'0.00000675',internal_reasoning:'0.00000675'}},
      {...e,tag:'alternative/no-zdr'}, {...e,tag:'alternative/expensive',pricing:{prompt:'0.00000136',completion:'0.00000675'}}];
    return mode==='fallbacks'?[e,{...e,tag:'alternative/valid'},
      {...e,tag:'alternative/expensive',pricing:{prompt:'1',completion:'1'}},
      {...e,tag:'alternative/no-json',supported_parameters:[]},{...e,tag:'alternative/no-zdr'},
      {...e,tag:'alternative/small',context_length:1000}]:[e];
  };
  const fetcher=(async(url,init)=>{
    assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+key);
    const u=String(url),body=init?.body?JSON.parse(String(init.body)):null;seen.push({url:u,body});
    if(u===OPENROUTER_URL+'/key')return Response.json({data:{usage:0,limit:mode==='unlimited'?null:mode==='large_limit'?20:10,
      limit_remaining:mode==='empty_key'?0:10,limit_reset:mode==='reset'?'monthly':null,is_management_key:mode==='management',is_provisioning_key:false}});
    if(u===OPENROUTER_URL+'/models')return Response.json({data:models.map(id=>{
      const {context,rates}=openRouterModel(id);
      return {id,context_length:mode==='changed_context'?context+1:context,
        pricing:{prompt:mode==='missing_price'?null:String(rates.input/1e6),completion:String(rates.output/1e6),
          ...(mode==='raised_price'?{overrides:[{prompt:'1',completion:'1'}]}:{})},
        architecture:{input_modalities:['text','image','file']},supported_parameters:mode==='no_schema'?[]:['structured_outputs','response_format','reasoning']};})});
    if(u===OPENROUTER_URL+'/endpoints/zdr')return Response.json({data:models
      .filter(id=>mode!=='missing_zdr'||id!==MODELS.questions).flatMap(endpoints).filter(e=>e.tag!=='alternative/no-zdr')});
    if(u.startsWith(OPENROUTER_URL+'/models/')&&u.endsWith('/endpoints'))
      return Response.json({data:{endpoints:endpoints(u.slice((OPENROUTER_URL+'/models/').length,-'/endpoints'.length))}});
    assert.equal(u,OPENROUTER_URL+'/chat/completions');generations++;
    if(mode==='network')throw new Error(key);
    if(['http','http_paid','http_bad_usage','http_502'].includes(mode)||mode==='http_once'&&generations===1)return Response.json({id:'gen-http-fixture',
      error:{message:key+' quota',metadata:{provider_name:'Google Vertex',error_type:'rate_limit',provider_code:'RESOURCE_EXHAUSTED',
        raw:JSON.stringify({error:{code:mode==='http_502'?502:429,status:'RESOURCE_EXHAUSTED',message:'private source '+key}})}},
      ...(['http_paid','http_once','http_502'].includes(mode)?{usage:{...response().usage,source_text:key}}:{}),
      ...(mode==='http_bad_usage'?{usage:{...response().usage,cost:key}}:{})},
      {status:mode==='http_502'?502:429,headers:{'x-request-id':'fixture-request-123',...(mode==='http_once'?{'Retry-After':'45'}:{})}});
    const raw:any=response();raw.model=mode==='model_swap'?'unexpected/model':body.model;
    if(mode==='missing_usage')delete raw.usage;
    if(mode==='missing_cost')delete raw.usage.cost;
    if(mode==='missing_reasoning')delete raw.usage.completion_tokens_details;
    if(mode==='overrun')raw.usage.cost=8;
    if(mode==='truncated')raw.choices[0].finish_reason='length';
    if(mode==='upstream_error'||['upstream_once','top_once'].includes(mode)&&generations===1){
      raw.choices[0].finish_reason='error';raw.choices[0].message.content='{"partial":';
      raw.choices[0].error={code:429,message:key+' private upstream diagnostic'};
      raw.usage={prompt_tokens:0,completion_tokens:0,total_tokens:0,cost:0};
      if(mode==='top_once'){raw.error=raw.choices[0].error;delete raw.choices[0].error;}
    }
    if(mode==='bad_json'||mode==='retry_once'&&generations===1)raw.choices[0].message.content=key;
    if(mode==='bad_schema')raw.choices[0].message.content='{"value":"question","invented":true}';
    return Response.json(raw);
  }) as typeof fetch;
  return {fetcher,seen,requestIntervalMs:0};
}
test('OpenRouter payload uses native PDF/PNG, strict schema, privacy and fixed price/model without paid OCR',()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  const p=buildOpenRouterPayload({...request,model:MODELS.vision,kind:'Reviews',pdf:Buffer.from('%PDF-1.7'),images:[['page=2',png]]});
  assert.deepEqual(p.plugins,[{id:'file-parser',pdf:{engine:'native'}}]);
  const content=p.messages[1].content as Array<any>;
  assert.match(content[0].file.file_data,/^data:application\/pdf;base64,/);
  assert.equal(content[1].text,'page=2');assert.match(content[2].image_url.url,/^data:image\/png;base64,/);
  assert.equal(p.response_format.json_schema!.schema.additionalProperties,false);
  assert.deepEqual(p.provider,{order:[OPENROUTER_UPSTREAM],require_parameters:true,allow_fallbacks:true,data_collection:'deny',zdr:true,max_price:{prompt:4,completion:18,request:0}});
  assert.equal(p.stream,false);assert.equal('models'in p,false);assert.equal('tools'in p,false);
  assert.equal(buildOpenRouterPayload(request).max_tokens,16384);
  for(const change of [{pdf:Buffer.from('%PDF-1.7')},{images:[['crop',png]] as Array<[string,Uint8Array]>},
    {kind:'Reviews'},{pdf_uri:'https://private.invalid/file'},{maxOutputTokens:16385},{maxOutputTokens:0},{prompt:''},
    {model:'openrouter/auto'}])assert.throws(()=>buildOpenRouterPayload({...request,...change}));
  assert.throws(()=>buildOpenRouterPayload({...request,model:MODELS.vision,pdf:Buffer.from('not a PDF')}));
});
test('OpenRouter measured usage counts reasoning once and keeps missing thinking unconfirmed',()=>{
  const u=openRouterUsage(response().usage);assert.equal(u.candidatesTokenCount,30);assert.equal(u.thinking_tokens,10);assert.equal(u.totalTokenCount,130);
  const raw:any=response().usage;delete raw.completion_tokens_details;delete raw.prompt_tokens_details;
  assert.equal(openRouterUsage(raw).thinking_tokens,null);assert.equal(openRouterUsage(raw).cached_tokens,null);
  for(const change of [{cost:null},{cost:-1},{prompt_tokens:NaN},{completion_tokens:-1},{total_tokens:140},
    {completion_tokens_details:{reasoning_tokens:31}},{is_byok:true}])assert.throws(()=>openRouterUsage({...raw,...change}),BudgetError);
  assert.throws(()=>openRouterUsage(undefined),BudgetError);
});
test('explicit Astra/Sonnet/Opus trial enforces roles, request-sized allowance and actual cost without changing defaults',async()=>{
  const b=makeBudget(23),stats=freshMetrics(),t=transport('ok',Object.values(TRIAL_MODELS));
  const session=openRouterSession(key,stats,b,{...t,profile:'astra-sonnet-opus'});
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1024,16);png.writeUInt32BE(1024,20);
  const vision={...request,model:TRIAL_MODELS.vision,kind:'VisualInventory',images:[['page=1',png]] as Array<[string,Uint8Array]>};
  const payload=buildOpenRouterPayload(vision,[], 'astra-sonnet-opus');
  assert.equal(payload.max_completion_tokens,16384);assert.equal(payload.max_tokens,undefined);
  assert.equal((payload.messages[1].content as any[])[1].image_url.detail,'original');
  assert.equal('temperature'in payload,false);assert.equal(payload.response_format.type,'json_object');
  assert.ok(trialInputAllowance(vision)<50_000);assert.ok(trialInputAllowance({...vision,images:[...vision.images,...vision.images]})>trialInputAllowance(vision));
  for(const r of [{...vision,model:TRIAL_MODELS.review},{...vision,pdf:Buffer.from('%PDF-')},
    {...request,model:TRIAL_MODELS.questions,images:vision.images}])assert.throws(()=>buildOpenRouterPayload(r,[], 'astra-sonnet-opus'));
  assert.throws(()=>buildOpenRouterPayload(vision));
  const routed=modelRequest(session.generate,stats,{model:TRIAL_MODELS.vision,skimModel:TRIAL_MODELS.vision,
    questionModel:TRIAL_MODELS.questions,reviewModel:TRIAL_MODELS.review});
  try{
    await routed('VisualInventory',schema,{prompt:'image',images:vision.images});
    await routed('QuestionSet',schema,{prompt:'verified JSON'});
    await routed('CropReadings',schema,{prompt:'blind source reading',images:vision.images});
    await routed('QuestionReviews',schema,{prompt:'review all fields',images:vision.images});
    const calls=t.seen.filter(s=>s.body);
    assert.deepEqual(calls.map(c=>c.body.model),[TRIAL_MODELS.vision,TRIAL_MODELS.questions,TRIAL_MODELS.review,TRIAL_MODELS.review]);
    assert.ok(stats.usage.every(u=>u.reservation_basis==='request_bytes_and_image_dimensions_allowance'&&u.counted_input_tokens===null));
    assert.equal(b.spent,.005);assert.equal(b.remaining,22.995);assert.equal(stats.input_tokens,400);
    assert.equal(MODELS.vision,'google/gemini-3.1-pro-preview');
  }finally{await session.close();b.close();}
  assert.throws(()=>makeBudget(24),BudgetError);
});
test('OpenRouter response parsing does not expose invalid content and refuses incomplete outputs',()=>{
  assert.deepEqual(parseOpenRouterResponse(response(),schema),{value:'question'});
  const raw:any=response();raw.choices[0].message.content=key;
  assert.throws(()=>parseOpenRouterResponse(raw,schema),e=>e instanceof SchemaValidationError&&!String(e).includes(key));
  for(const finish of ['length','error','tool_calls','content_filter',null]){
    raw.choices[0].finish_reason=finish;assert.throws(()=>parseOpenRouterResponse(raw,schema));
  }
  for(const code of [429,503]){
    const r:any=response();r.choices[0].error={code,message:key};
    assert.throws(()=>parseOpenRouterResponse(r,schema),e=>e instanceof Error&&!(e instanceof SchemaValidationError)&&
      String(e).includes('상위 공급자')&&!String(e).includes(key));
  }
});
test('OpenRouter HTTP 200 upstream 429 retries twice then stops, keeping every response separate from schema retries',async(context)=>{
  const waits:number[]=[];context.mock.method(timers,'setTimeout',async(ms:number)=>{waits.push(ms);});
  const b=makeBudget(),stats=freshMetrics(),t=transport('upstream_error'),raws:unknown[]=[];
  const s=openRouterSession(key,stats,b,{...t,onResponse:(_kind,r)=>raws.push(r)});
  const call=modelRequest(s.generate,stats,{model:MODELS.skim});
  try{
    await assert.rejects(call('DocumentMap',schema,{prompt:request.prompt}),e=>e instanceof Error&&
      !(e instanceof SchemaValidationError)&&/429/.test(e.message)&&!e.message.includes(key));
    assert.equal(stats.model_calls,3);assert.equal(t.seen.filter(c=>c.body).length,3);
    assert.equal(b.spent,0);assert.equal(b.reserved,0);assert.equal(raws.length,3);
    assert.deepEqual(waits,[30000,60000]);assert.equal(stats.stages.length,1);assert.equal(stats.stages[0].attempt,1);
    assert.deepEqual(stats.usage.map(r=>r.application_http_attempt),[1,2,3]);
    await assert.rejects(s.generate({...request,model:MODELS.skim}));
    assert.equal(t.seen.filter(c=>c.body).length,3);
  }finally{b.close();}
});
test('OpenRouter recovers from HTTP and embedded 429 with Retry-After, fresh reservations and measured retry usage',async(context)=>{
  const waits:number[]=[];context.mock.method(timers,'setTimeout',async(ms:number)=>{waits.push(ms);});
  for(const mode of ['http_once','upstream_once','top_once']){
    waits.length=0;
    const b=makeBudget(),stats=freshMetrics(),t=transport(mode),raws:any[]=[],s=openRouterSession(key,stats,b,{...t,onResponse:(_kind,raw)=>raws.push(raw)});
    const call=modelRequest(s.generate,stats,{model:MODELS.questions});
    try{
      assert.deepEqual(await call('QuestionSet',schema,{prompt:request.prompt}),{value:'question'});
      assert.deepEqual(waits,[mode==='http_once'?45000:30000]);assert.equal(stats.model_calls,2);
      assert.deepEqual(raws.map(r=>r._application_http_attempt),[1,2]);
      assert.equal(stats.stages.length,1);assert.equal(stats.stages[0].attempt,1);
      assert.equal(stats.total_tokens,mode==='http_once'?260:null);assert.equal(b.spent,mode==='http_once'?.0025:.00125);
      if(mode!=='http_once'){
        for(const field of ['input_tokens','output_tokens','thinking_tokens','cached_tokens'] as const)assert.equal(stats[field],null);
        assert.equal(stats.usage[0].token_usage_status,'unconfirmed_partial_error');
        assert.equal(stats.usage[0].promptTokenCount,null);assert.equal(stats.usage[1].promptTokenCount,100);
      }
      assert.equal(b.reserved,0);assert.equal(b.blocked,false);
      const rows=readFileSync(b.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(rows.map(r=>r.type),['header','reserve','settle','reserve','settle']);
      assert.notEqual(rows[1].id,rows[3].id);
      assert.deepEqual(t.seen.filter(r=>r.body).map(r=>r.body.model),[request.model,request.model]);
    }finally{await s.close();b.close();}
  }
});
test('OpenRouter retry stops on cancellation, insufficient remaining budget, long Retry-After or non-429 failure',async(context)=>{
  const waits:number[]=[];let cancel:AbortController|undefined;
  context.mock.method(timers,'setTimeout',async(ms:number)=>{waits.push(ms);cancel?.abort();});
  for(const mode of ['cancel','budget','long_wait','http_502']){
    waits.length=0;cancel=mode==='cancel'?new AbortController():undefined;
    const b=makeBudget(mode==='budget'?1.7:10),t=transport(mode==='http_502'?mode:'http_once');
    const fetcher:typeof fetch=async(url,init)=>{
      const res=await t.fetcher(url,init);
      if(!String(url).endsWith('/chat/completions'))return res;
      const raw=await res.json();if(mode==='budget')raw.usage.cost=.3;
      const headers=new Headers(res.headers);if(mode==='long_wait')headers.set('Retry-After','121');
      return Response.json(raw,{status:res.status,headers});
    };
    const s=openRouterSession(key,freshMetrics(),b,{fetcher,requestIntervalMs:0,signal:cancel?.signal});
    try{
      await assert.rejects(s.generate({...request,model:MODELS.skim,kind:'PageIndex'}));
      assert.equal(t.seen.filter(r=>r.body).length,1);assert.equal(b.reserved,0);assert.equal(b.blocked,false);
      assert.deepEqual(waits,mode==='cancel'||mode==='budget'?[45000]:[]);
      assert.equal(b.spent,mode==='budget'?.3:.00125);
    }finally{await s.close();b.close();}
  }
});
test('OpenRouter HTTP retries and the existing single format retry have separate attempt counts',async(context)=>{
  context.mock.method(timers,'setTimeout',async()=>{});
  const b=makeBudget(),t=transport(),stats=freshMetrics(),raws:any[]=[];let posts=0;
  const fetcher:typeof fetch=async(url,init)=>{
    const res=await t.fetcher(url,init);if(!String(url).endsWith('/chat/completions'))return res;
    const raw:any=await res.json();posts++;
    if(posts===1||posts===3)raw.error={code:429};
    if(posts===2)raw.choices[0].message.content='invalid JSON';
    return Response.json(raw);
  };
  const s=openRouterSession(key,stats,b,{fetcher,requestIntervalMs:0,onResponse:(_kind,r)=>raws.push(r)});
  try{
    const call=modelRequest(s.generate,stats,{model:MODELS.questions});
    assert.deepEqual(await call('QuestionSet',schema,{prompt:request.prompt}),{value:'question'});
    assert.equal(posts,4);assert.equal(stats.model_calls,4);assert.equal(b.spent,.005);assert.equal(b.reserved,0);
    assert.deepEqual(stats.stages.map(r=>r.attempt),[1,2]);assert.deepEqual(raws.map(r=>r._application_http_attempt),[1,2,1,2]);
  }finally{await s.close();b.close();}
});
test('OpenRouter access check is read-only, reports key cap not account wallet, and works without a budget',async()=>{
  const t=transport(),stats=freshMetrics(),s=openRouterSession(key,stats,undefined,t),r=await s.checkAccess();
  assert.equal(r.generation_tested,false);assert.equal(r.account_balance_usd,null);assert.equal(r.key_remaining_usd,10);
  assert.equal(r.upstream,OPENROUTER_UPSTREAM);assert.equal(r.output_formats.questions,'json_object_with_local_zod');
  assert.equal(t.seen.length,6);assert.ok(t.seen.every(c=>c.body===null));assert.equal(stats.usage.length,0);
  await assert.rejects(s.generate(request),BudgetError);assert.equal(t.seen.length,6);
  for(const value of ['',undefined,'not-a-key','sk-or-secret\n'])assert.throws(()=>validateOpenRouterKey(value));
});
test('OpenRouter checks eligible upstream ZDR, format, capacity and price before reserving or sending a PDF',async()=>{
  for(const mode of ['missing_zdr','endpoint_unavailable','endpoint_too_small','endpoint_no_schema','endpoint_no_json',
    'endpoint_expensive','endpoint_invalid_price','endpoint_request_fee']){
    const b=makeBudget(),t=transport(mode),s=openRouterSession(key,freshMetrics(),b,t);
    try{await assert.rejects(s.generate({...request,model:MODELS.skim,kind:'PageIndex',pdf:Buffer.from('%PDF-1.7')}));
      assert.equal(b.reserved,0);assert.equal(b.spent,0);assert.equal(b.blocked,false);assert.ok(t.seen.every(c=>c.body===null));}
    finally{b.close();}
  }
});
test('OpenRouter allows checked same-model alternatives, even without the preferred route, but excludes unsafe routes',async()=>{
  for(const mode of ['fallbacks','wrong_upstream']){
    const b=makeBudget(),t=transport(mode),stats=freshMetrics(),s=openRouterSession(key,stats,b,t);
    try{
      const access=await s.checkAccess();await s.generate(request);
      const p=t.seen.find(c=>c.body)!.body;
      assert.equal(p.model,request.model);assert.equal('models'in p,false);assert.equal(p.provider.allow_fallbacks,true);
      assert.deepEqual(p.provider.only,mode==='fallbacks'?[OPENROUTER_UPSTREAM,'alternative/valid']:['google-ai-studio']);
      assert.deepEqual(p.provider.order,mode==='fallbacks'?[OPENROUTER_UPSTREAM]:[]);
      assert.equal(p.provider.zdr,true);assert.equal(p.provider.data_collection,'deny');assert.equal(p.provider.require_parameters,true);
      assert.deepEqual(access.allowed_providers[request.model],p.provider.only);assert.deepEqual(stats.usage[0].allowed_providers,p.provider.only);
    }finally{await s.close();b.close();}
  }
});
test('Flash priority stays within its verified price cap and reserves that cost without admitting non-ZDR routes',async()=>{
  const b=makeBudget(),t=transport('flash_priority'),stats=freshMetrics(),s=openRouterSession(key,stats,b,t);
  try{
    const access=await s.checkAccess();assert.deepEqual(access.allowed_providers[MODELS.skim],[OPENROUTER_UPSTREAM+'/priority']);
    await s.generate({...request,model:MODELS.skim,kind:'PageIndex'});
    const p=t.seen.find(c=>c.body)!.body;
    assert.deepEqual(p.provider.only,[OPENROUTER_UPSTREAM+'/priority']);assert.equal(p.provider.zdr,true);
    assert.deepEqual(p.provider.max_price,{prompt:1.35,completion:6.75,request:0});
    assert.equal(stats.usage[0].reserved_cost_usd,(1_048_576*1.35+16384*6.75)/1e6);
    assert.equal(b.spent,.00125);assert.equal(b.reserved,0);assert.equal(b.limit,10);
  }finally{await s.close();b.close();}
});
test('OpenRouter Vertex Opus JSON mode retains the schema in its prompt and rejects extra fields locally',async()=>{
  const payload=buildOpenRouterPayload(request);
  assert.deepEqual(payload.response_format,{type:'json_object'});
  const content=payload.messages[1].content as Array<any>;
  assert.match(content.at(-1).text,/"additionalProperties":false/);assert.ok(content.every(p=>p.type==='text'));
  const b=makeBudget(),t=transport('bad_schema');
  try{await assert.rejects(openRouterSession(key,freshMetrics(),b,t).generate(request),SchemaValidationError);
    assert.equal(b.spent,.00125);assert.equal(b.reserved,0);}
  finally{b.close();}
});
test('OpenRouter records redacted HTTP status and request ID without losing known cost or inventing missing usage',async(context)=>{
  context.mock.method(timers,'setTimeout',async()=>{});
  for(const mode of ['http','http_paid','http_bad_usage','network']){
    const b=makeBudget(),t=transport(mode),stats=freshMetrics(),raws:any[]=[],s=openRouterSession(key,stats,b,
      {...t,onResponse:(_kind,raw)=>raws.push(raw)});
    try{
      await assert.rejects(s.generate(request),e=>{
        assert.equal(e instanceof HttpResponseError,!['network','http_paid'].includes(mode));
        if(e instanceof HttpResponseError){assert.equal(e.status,429);assert.equal(e.request_id,'fixture-request-123');}
        return !String(e).includes(key);
      });
      assert.equal(raws.length,mode==='http_paid'?3:1);assert.equal(raws[0]._http_status,mode==='network'?null:429);
      assert.equal(raws[0]._request_id,mode==='network'?null:'fixture-request-123');
      assert.equal(raws[0].id,mode==='network'?null:'gen-http-fixture');assert.equal(raws[0].model,undefined);
      if(mode!=='network')assert.deepEqual(raws[0]._diagnostics,{provider_name:'Google Vertex',error_type:'rate_limit',provider_code:'RESOURCE_EXHAUSTED',upstream_code:429,upstream_status:'RESOURCE_EXHAUSTED',upstream_type:null});
      assert.ok(!JSON.stringify(raws).includes(key));assert.ok(!JSON.stringify(raws).includes('private source'));
      assert.equal(b.spent,mode==='http_paid'?.00375:0);assert.equal(b.blocked,mode!=='http_paid');
      if(mode==='http_paid'){assert.equal(b.reserved,0);assert.equal(stats.total_tokens,390);assert.equal(raws[0].usage.cost,.00125);}
      else{assert.ok(b.reserved>0);assert.equal(raws[0].usage,null);}
      const before=t.seen.length;await assert.rejects(s.generate(request));assert.equal(t.seen.length,before);
    }finally{await s.close();b.close();}
  }
});
test('OpenRouter ledger cannot be confused with a Gemini/GCP ledger, including renamed files',async()=>{
  const b=makeBudget(),path=b.path;b.close();assert.throws(()=>new Budget(path,10),BudgetError);
  const resumed=new Budget(path,10,'openrouter');resumed.close();
  const other=new Budget(join(mkdtempSync(join(tmpdir(),'proofolio-old-budget-')),'renamed.jsonl'),10),t=transport();
  try{await assert.rejects(openRouterSession(key,freshMetrics(),other,t).generate(request),BudgetError);assert.equal(t.seen.length,0);}
  finally{other.close();}
  assert.throws(()=>new Budget(other.path,10,'openrouter'),BudgetError);
});
test('OpenRouter settles API-reported cost rather than rate-estimating measured output',async()=>{
  const b=makeBudget(),stats=freshMetrics(),t=transport(),raws:any[]=[],s=openRouterSession(key,stats,b,{...t,onResponse:(_kind,r)=>raws.push(r)});
  try{
    assert.deepEqual(await s.generate(request),{value:'question'});assert.equal(b.spent,.00125);assert.equal(b.reserved,0);
    assert.equal(stats.total_tokens,130);assert.equal(stats.input_tokens,100);assert.equal(stats.output_tokens,30);assert.equal(stats.thinking_tokens,10);
    assert.equal(stats.usage[0].counted_input_tokens,null);assert.equal(stats.usage[0].reserved_input_tokens,1_000_000);
    assert.equal(stats.usage[0].reserved_cost_usd,5.4096);assert.equal(stats.usage[0].provider_retries,null);
    assert.equal(stats.usage[0].cost_source,'api_usage_cost');assert.equal(raws.length,1);
    assert.equal(t.seen.filter(c=>c.body).length,1);assert.ok(!readFileSync(b.path,'utf8').includes(key));
  }finally{b.close();}
});
test('OpenRouter missing usage or connection failure blocks spending without retry or secret leaks',async()=>{
  for(const mode of ['network','http','missing_usage','missing_cost','overrun']){
    const b=makeBudget(),t=transport(mode),s=openRouterSession(key,freshMetrics(),b,t);
    try{
      await assert.rejects(s.generate(request),e=>!String(e).includes(key));assert.equal(b.blocked,true);
      const calls=t.seen.length;await assert.rejects(s.generate(request));assert.equal(t.seen.length,calls);
      if(mode!=='overrun')assert.ok(b.reserved>0);
    }finally{b.close();}
  }
});
test('OpenRouter invalid key limits, stale model metadata or insufficient reservation never generate',async()=>{
  for(const mode of ['unlimited','empty_key','reset','management','raised_price','missing_price','no_schema','changed_context','small_budget']){
    const b=makeBudget(mode==='small_budget'?5:10),t=transport(mode),s=openRouterSession(key,freshMetrics(),b,t);
    try{await assert.rejects(s.generate(request));assert.equal(b.spent,0);assert.equal(b.reserved,0);assert.ok(t.seen.every(c=>c.body===null));}
    finally{b.close();}
  }
});
test('OpenRouter account key limit never becomes the local test budget',async()=>{
  const b=makeBudget(),t=transport('large_limit');
  try{await openRouterSession(key,freshMetrics(),b,t).generate(request);assert.equal(b.limit,10);assert.equal(b.spent,.00125);}
  finally{b.close();}
});
test('OpenRouter incomplete or malformed output still accounts for paid usage',async()=>{
  for(const mode of ['truncated','bad_json','model_swap']){
    const b=makeBudget(),t=transport(mode),s=openRouterSession(key,freshMetrics(),b,t);
    try{await assert.rejects(s.generate(request));assert.equal(b.spent,.00125);assert.equal(b.reserved,0);assert.equal(b.blocked,false);}
    finally{b.close();}
  }
});
test('OpenRouter shared request wrapper permits only one format retry and records each actual attempt',async()=>{
  for(const mode of ['retry_once','bad_json']){
    const b=makeBudget(),stats=freshMetrics(),t=transport(mode),s=openRouterSession(key,stats,b,t);
    const call=modelRequest(s.generate,stats,{model:MODELS.questions});
    try{
      if(mode==='retry_once')assert.deepEqual(await call('QuestionSet',schema,{prompt:request.prompt}),{value:'question'});
      else await assert.rejects(call('QuestionSet',schema,{prompt:request.prompt}),SchemaValidationError);
      assert.equal(stats.model_calls,2);assert.equal(stats.stages[1].attempt,2);assert.equal(b.spent,.0025);
      assert.equal(t.seen.filter(c=>c.body).length,2);
    }finally{b.close();}
  }
});
test('OpenRouter serializes concurrent reservations and honors cancellation before inference',async()=>{
  const b=makeBudget(),stats=freshMetrics(),t=transport(),s=openRouterSession(key,stats,b,t);
  try{
    await Promise.all([s.generate(request),s.generate(request)]);assert.equal(stats.usage.length,2);assert.equal(b.reserved,0);
    const cancelled=openRouterSession(key,stats,b,{...t,signal:AbortSignal.abort()}),before=t.seen.length;
    await assert.rejects(cancelled.generate(request));assert.equal(t.seen.length,before);
  }finally{b.close();}
});
test('OpenRouter spaces paid requests without retry and aborts before reserving the next request',async()=>{
  const b=makeBudget(),t=transport(),starts:number[]=[],controller=new AbortController();
  const fetcher:typeof fetch=async(url,init)=>{if(String(url).endsWith('/chat/completions'))starts.push(performance.now());return t.fetcher(url,init);};
  const s=openRouterSession(key,freshMetrics(),b,{fetcher,requestIntervalMs:40,signal:controller.signal});
  try{
    await Promise.all([s.generate(request),s.generate(request)]);
    assert.equal(starts.length,2);assert.ok(starts[1]-starts[0]>=35);
    const pending=s.generate(request);setTimeout(()=>controller.abort(),5);
    await assert.rejects(pending);assert.equal(starts.length,2);assert.equal(b.reserved,0);assert.equal(b.spent,.0025);
    assert.throws(()=>openRouterSession(key,freshMetrics(),b,{requestIntervalMs:-1}));
  }finally{await s.close();b.close();}
});
test('OpenRouter unreported reasoning is not guessed from text or output token counts',async()=>{
  const b=makeBudget(),stats=freshMetrics(),t=transport('missing_reasoning');
  try{await openRouterSession(key,stats,b,t).generate(request);assert.equal(stats.thinking_tokens,null);assert.equal(stats.usage[0].thinking_tokens_status,'unconfirmed');}
  finally{b.close();}
});
test('OpenRouter environment/CLI ignores legacy credentials and requires separate explicit spending approval',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'proofolio-router-cli-')),envPath=join(dir,'test.env'),ledger=join(dir,'ledger.jsonl');
  writeFileSync(envPath,'OPENROUTER_API_KEY='+key+'\nOPENROUTER_MODEL='+MODELS.vision+'\nGEMINI_API_KEY=old-key\nUNRELATED=skip\n');
  const env:NodeJS.ProcessEnv={};loadEnv(envPath,env);assert.equal(env.OPENROUTER_API_KEY,key);assert.equal(env.GEMINI_API_KEY,undefined);assert.equal(env.UNRELATED,undefined);
  const errors:string[]=[];
  for(const extra of [[],['--max-cost-usd','10','--gcp-project','test-project']]){
    assert.equal(await runCli(['missing.pdf','--provider','openrouter','--track','design','--budget-ledger',ledger,...extra],
      {env,envPath,stderr:s=>errors.push(s)}),1);assert.equal(existsSync(ledger),false);
  }
  assert.ok(errors.every(e=>!e.includes(key)));
  const pdf=join(dir,'fixture.pdf');writeFileSync(pdf,'%PDF-1.7');let called=false;
  const code=await runCli([pdf,'--provider','openrouter','--track','design','--budget-ledger',ledger,'--max-cost-usd','10'],
    {env,envPath,stdout:()=>{},stderr:()=>{},analyze:async(_bytes,o)=>{
      called=true;assert.equal(o.apiKey,key);assert.equal(o.provider,'openrouter');assert.equal(o.model,MODELS.vision);
      assert.equal(o.skimModel,MODELS.skim);assert.equal(o.questionModel,MODELS.questions);assert.equal('vertex' in o,false);
      return {metrics:freshMetrics()} as any;
    }});
  assert.equal(code,0);assert.equal(called,true);assert.equal(existsSync(ledger+'.lock'),false);
});
