import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Budget,BudgetError,BASE_URL,buildPayload,fileSession,freshMetrics,parseModelResponse,requestJson,SchemaValidationError,usageCost,validateConfig} from '../src/gemini.ts';
import {DocumentMap,VisualInventory,responseSchema} from '../src/schema.ts';

const model='gemini-3.8-flash',schema=z.strictObject({value:z.string().min(1)});
const response=(value:unknown={value:'test'})=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'hidden',thought:true},{text:JSON.stringify(value)}]}}],
  usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,thoughtsTokenCount:7,totalTokenCount:22}});
async function budget(){return new Budget(join(await mkdtemp(join(tmpdir(),'portfolio-budget-')),'ledger.jsonl'));}
function transport(mode='ok'){
  const seen:Array<{url:string;init:RequestInit}>=[];let processing=true;
  const fetcher=(async(url:RequestInfo|URL,init:RequestInit={})=>{const u=String(url);seen.push({url:u,init});let body:unknown={},headers:Record<string,string>={},status=200;
    if(init.method==='DELETE'){if(mode==='cleanup_failed')status=503;}
    else if(u===BASE_URL+'/upload/v1beta/files')headers={'X-Goog-Upload-URL':mode==='untrusted'?'https://evil.invalid/upload':BASE_URL+'/upload/session'};
    else if(u===BASE_URL+'/upload/session')body={file:{name:'files/test',state:mode==='failed'||mode==='cleanup_failed'?'FAILED':'PROCESSING'}};
    else if(u===BASE_URL+'/v1beta/files/test'){processing=false;body={name:'files/test',state:'ACTIVE',uri:u};}
    else if(u.endsWith(':countTokens'))body={totalTokens:10};
    else if(u.endsWith(':generateContent')){assert.equal(processing,false);body=response(mode==='schema_bad'?{value:''}:undefined);if(mode==='usage_missing')delete (body as any).usageMetadata;
      if(mode==='http_failed'){status=429;body={error:{message:'key=fake-key'}};}}
    return new Response(JSON.stringify(body),{status,headers});}) as typeof fetch;
  return {fetcher,seen};
}
test('17 binary Files upload ACTIVE polling reuse cleanup and full usage',async()=>{const b=await budget(),stats=freshMetrics(),t=transport(),session=fileSession('fake-key',stats,b,{fetcher:t.fetcher});
  const pdf=Buffer.from('%PDF-test');try{for(let i=0;i<2;i++)assert.deepEqual(await session.generate({kind:'test',schema,prompt:'분석',pdf,model}),{value:'test'});
    assert.equal(stats.uploads,1);assert.equal(stats.file_reuses,1);assert.equal(stats.usage[0].thoughtsTokenCount,7);assert.ok(stats.estimated_cost_usd>0);
    const upload=t.seen.find(s=>s.url===BASE_URL+'/upload/session')!;assert.deepEqual(upload.init.body,pdf);
    const generate=t.seen.find(s=>s.url.endsWith(':generateContent'))!;assert.equal(JSON.parse(String(generate.init.body)).contents[0].parts[0].fileData.fileUri,BASE_URL+'/v1beta/files/test');
  }finally{await session.close();await session.close();b.close();}assert.equal(t.seen.at(-1)!.init.method,'DELETE');assert.equal(t.seen.filter(s=>s.init.method==='DELETE').length,1);});
test('18 failed processing cleanup failures untrusted upload URLs',async()=>{for(const mode of ['failed','cleanup_failed','untrusted']){const b=await budget(),stats=freshMetrics(),t=transport(mode),s=fileSession('fake-key',stats,b,{fetcher:t.fetcher});
  try{await assert.rejects(s.generate({kind:'test',schema,prompt:'분석',pdf:Buffer.from('%PDF-test'),model}));}finally{await s.close();b.close();}
  assert.equal(t.seen.filter(v=>v.init.method==='DELETE').length,mode==='untrusted'?0:1);assert.equal(stats.cleanup_failures,mode==='cleanup_failed'?1:0);
  assert.ok(t.seen.every(s=>s.url.startsWith(BASE_URL)));}});
test('20 REST request contract malformed output and safe errors',async()=>{const payload=buildPayload({kind:'test',schema,prompt:'분석',model,pdf:Buffer.from('%PDF-test')});
  assert.ok(payload.generationConfig.responseJsonSchema);assert.equal(Buffer.from((payload.contents[0].parts[0] as any).inlineData.data,'base64').toString(),'%PDF-test');
  assert.deepEqual(parseModelResponse(response(),schema,'fake-key'),{value:'test'});
  for(const bad of [{candidates:[]},{candidates:[{finishReason:'MAX_TOKENS'}]},{candidates:[{finishReason:'STOP',content:null}]},response({})])assert.throws(()=>parseModelResponse(bad,schema,'fake-key'));
  for(const pair of [['','gemini-test'],['key\nvalue','gemini-test'],['key','gemini-test/path']])assert.throws(()=>validateConfig(pair[0],pair[1]));
  await assert.rejects(requestJson(BASE_URL,{},'fake-key',(async()=>new Response(JSON.stringify({error:{message:'fake-key bad'}}),{status:400})) as typeof fetch),e=>String(e).includes('[REDACTED]')&&!String(e).includes('fake-key'));
  await assert.rejects(requestJson(BASE_URL,{},'fake-key',(async()=>{throw new Error('fake-key');}) as typeof fetch),e=>!String(e).includes('fake-key'));
  for(const body of ['not json','[]'])await assert.rejects(requestJson(BASE_URL,{},'key',(async()=>new Response(body)) as typeof fetch));});
test('21 wire schema property names preserved while local constraints remain',()=>{const shape=z.strictObject({pattern:z.string().max(3)}),wire=responseSchema(shape) as any;
  assert.deepEqual(wire.properties,{pattern:{type:'string'}});assert.deepEqual(wire.required,['pattern']);assert.equal(shape.safeParse({pattern:'long'}).success,false);
  const map=responseSchema(DocumentMap);assert.ok(!JSON.stringify(map).includes('$ref'));assert.ok(JSON.stringify(map).includes('project'));
  const recursive:z.ZodType=z.lazy(()=>z.object({child:recursive}));assert.throws(()=>responseSchema(recursive),/schemas/);});
test('22 schema errors do not log source values and invalid responses still cost',async()=>{const bad={coverage:'complete',limitations:[],links:[],regions:[{key:'r1',kind:'text_block',box:[0,0,500,500],description:'private-source-text',salient_text:null,
  identification:'clear',readability:'readable',source_role:'unknown',role_basis:'fake-key'}]};
  assert.throws(()=>parseModelResponse(response(bad),VisualInventory,'fake-key'),e=>String(e).includes('regions.0')&&!String(e).includes('private-source-text')&&!String(e).includes('fake-key'));
  const b=await budget(),stats=freshMetrics(),t=transport('schema_bad'),s=fileSession('fake-key',stats,b,{fetcher:t.fetcher});
  try{await assert.rejects(s.generate({kind:'test',schema,prompt:'분석',pdf:Buffer.from('%PDF-test'),model}),SchemaValidationError);assert.equal(stats.usage.length,1);assert.ok(b.spent>0);assert.equal(b.blocked,false);}
  finally{await s.close();b.close();}});
test('budget counts cached input thinking reservations and persists across processes',async()=>{assert.equal(usageCost(model,{promptTokenCount:100,cachedContentTokenCount:20,candidatesTokenCount:10,thoughtsTokenCount:30,totalTokenCount:140}),
  (80*.75+20*.075+40*3.75)/1e6);assert.throws(()=>usageCost(model,{totalTokenCount:99}),BudgetError);
  const b=await budget(),path=b.path,id=b.reserve(model,100,50);assert.throws(()=>new Budget(path));b.settle(id,model,{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120});
  const spent=b.spent;b.close();const reopened=new Budget(path);assert.equal(reopened.spent,spent);assert.throws(()=>reopened.reserve(model,20_000_000),BudgetError);reopened.close();
  assert.match(await readFile(path,'utf8'),/settle/);});
test('unsettled prior-process reservation cannot silently resume paid calls',async()=>{
  const b=await budget(),path=b.path;b.reserve(model,100);const reserved=b.reserved;b.close();
  const reopened=new Budget(path);try{assert.equal(reopened.blocked,true);assert.equal(reopened.reserved,reserved);
    assert.throws(()=>reopened.reserve(model,1),BudgetError);assert.match(await readFile(path,'utf8'),/unsettled_previous_process/);
  }finally{reopened.close();}
});
test('budget unknown usage HTTP failure and reservation overrun stop subsequent calls',async()=>{for(const mode of ['usage_missing','http_failed']){const b=await budget(),stats=freshMetrics(),t=transport(mode),s=fileSession('fake-key',stats,b,{fetcher:t.fetcher});
  try{await assert.rejects(s.generate({kind:'test',schema,prompt:'분석',pdf:Buffer.from('%PDF-test'),model}));assert.equal(b.blocked,true);
    const calls=t.seen.length;await assert.rejects(s.generate({kind:'test',schema,prompt:'분석',model}));assert.equal(t.seen.length,calls);assert.ok(b.reserved>0);
  }finally{await s.close();b.close();}}
  const b=await budget();try{const id=b.reserve(model,1,1);assert.throws(()=>b.settle(id,model,{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110}),BudgetError);assert.equal(b.blocked,true);}finally{b.close();}});
