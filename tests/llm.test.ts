import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import {mkdtemp,readFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Budget,BudgetError,HttpResponseError,requestJson,usageCost,priceFor} from '../src/llm.ts';
import {DocumentMap,responseSchema} from '../src/schema.ts';

const model='gemini-3.8-flash',schema=z.strictObject({value:z.string().min(1)});
test('Pro standard pricing includes long-context tier, cached input and thinking in reservations',async()=>{
  const pro='gemini-3.1-pro-preview';
  for(const input of [200_000,200_001]){
    const rates=priceFor(pro,new Date(),input),high=input>200_000;
    assert.deepEqual(rates,high?{input:4,output:18,cached:.4}:{input:2,output:12,cached:.2});
    const b=await budget();try{
      const id=b.reserve(pro,input,32768);
      assert.equal(b.reserved,(input*rates.input+32768*rates.output)/1e6);
      const usage={promptTokenCount:input,cachedContentTokenCount:1000,candidatesTokenCount:100,thoughtsTokenCount:200,totalTokenCount:input+300};
      assert.equal(b.settle(id,pro,usage),((input-1000)*rates.input+1000*rates.cached+300*rates.output)/1e6);
      assert.equal(b.reserved,0);assert.equal(b.blocked,false);
    }finally{b.close();}
  }
  assert.throws(()=>priceFor(pro,new Date('2027-01-01')),BudgetError);
  assert.throws(()=>priceFor('gemini-unpriced'),BudgetError);
});
const BASE_URL='https://openrouter.ai/api/v1';
async function budget(){return new Budget(join(await mkdtemp(join(tmpdir(),'portfolio-budget-')),'ledger.jsonl'));}
test('HTTP diagnostics preserve status and safe request IDs, including non-JSON errors',async()=>{
  for(const json of [true,false]){
    const fetcher=(async()=>new Response(json?JSON.stringify({error:{message:'fake-key denied'},id:'body-id'}):'not json',
      {status:403,headers:{'x-request-id':'header-id'}})) as typeof fetch;
    await assert.rejects(requestJson(BASE_URL,{},'fake-key',fetcher),e=>e instanceof HttpResponseError&&e.status===403&&e.request_id==='header-id'&&!e.message.includes('fake-key'));
  }
  await assert.rejects(requestJson(BASE_URL,{},'fake-key',(async()=>Response.json({error:{message:'denied'},id:'fake-key'},
    {status:401,headers:{'x-request-id':'fake-key'}})) as typeof fetch),e=>e instanceof HttpResponseError&&e.request_id===null);
});
test('21 wire schema property names preserved while local constraints remain',()=>{const shape=z.strictObject({pattern:z.string().max(3)}),wire=responseSchema(shape) as any;
  assert.deepEqual(wire.properties,{pattern:{type:'string'}});assert.deepEqual(wire.required,['pattern']);assert.equal(shape.safeParse({pattern:'long'}).success,false);
  const map=responseSchema(DocumentMap);assert.ok(!JSON.stringify(map).includes('$ref'));assert.ok(JSON.stringify(map).includes('project'));
  const recursive:z.ZodType=z.lazy(()=>z.object({child:recursive}));assert.throws(()=>responseSchema(recursive),/schemas/);});
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
test('explicit unknown-cost hold preserves the cap/history and never fabricates a settlement or clears future failures',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'router-hold-')),'ledger.jsonl');
  let b=new Budget(path,10,'openrouter');const id=b.reserveUsd('google/gemini-3.8-flash',.817152);
  b.block('openrouter_generation_usage_unknown');const before=await readFile(path,'utf8');b.close();
  b=new Budget(path,10,'openrouter');
  for(const amount of [0,.81,NaN,Infinity])assert.throws(()=>b.approveUnknownCostHold('user-approved',id,amount),BudgetError);
  assert.throws(()=>b.approveUnknownCostHold('user-approved','wrong-id',.817152),BudgetError);
  b.approveUnknownCostHold('user-approved',id,.817152);
  assert.equal(b.limit,10);assert.equal(b.spent,0);assert.equal(b.remaining,9.182848);assert.equal(b.blocked,false);
  assert.equal(b.snapshot().held_request_actual_cost_usd,null);assert.equal(b.activeReserved,0);
  assert.equal(b.reserved,.817152);assert.equal(b.unknownCostHold,.817152);assert.throws(()=>b.settleUsd(id,0),BudgetError);
  const after=await readFile(path,'utf8');assert.ok(after.startsWith(before));assert.ok(!after.includes('"settle"'));
  b.approveUnknownCostHold('user-approved',id,.817152);assert.equal(await readFile(path,'utf8'),after);
  assert.throws(()=>b.approveUnknownCostHold('user-approved',id,.8),BudgetError);
  assert.throws(()=>b.reserveUsd(model,9.2),BudgetError);
  const paid=b.reserveUsd(model,1);b.settleUsd(paid,.1);b.close();
  b=new Budget(path,10,'openrouter');assert.equal(b.blocked,false);assert.equal(b.spent,.1);assert.equal(b.reserved,.817152);
  const fresh=b.reserveUsd(model,.2);b.block('openrouter_generation_usage_unknown');
  b.approveUnknownCostHold('user-approved',id,.817152);assert.equal(b.blocked,true);assert.equal(b.pending.get(fresh),.2);
  assert.throws(()=>b.reserveUsd(model,.1),BudgetError);b.block('reservation_exceeded');
  assert.throws(()=>b.approveUnknownCostHold('new-approval',fresh,.2),BudgetError);b.close();
  b=new Budget(path,10,'openrouter');try{assert.equal(b.blocked,true);assert.equal(b.unknownCostHold,.817152);assert.equal(b.activeReserved,.2);}finally{b.close();}
  for(const provider of [undefined,'openrouter'] as const){
    const wrong=new Budget(join(await mkdtemp(join(tmpdir(),'invalid-hold-')),'ledger'),10,provider),rid=wrong.reserveUsd(model,1);
    wrong.block(provider?'unsettled_previous_process':'openrouter_generation_usage_unknown');
    try{assert.throws(()=>wrong.approveUnknownCostHold('no-bypass',rid,1),BudgetError);}finally{wrong.close();}
  }
});
test('approved KRW extension preserves history, applies once and cannot bypass unknown usage',async()=>{
  const b=await budget(),path=b.path;b.capAdditionalKrw(1000,2000);
  const id=b.reserve(model,1000,1000);b.settle(id,model,{promptTokenCount:1000,candidatesTokenCount:1000,totalTokenCount:2000});
  const before=await readFile(path,'utf8'),spent=b.spent;
  b.approveAdditionalKrw('explicit-user-7000',7000,2000);
  assert.equal(b.spent,spent);assert.equal(b.remaining,3.5);assert.equal(b.snapshot().spend_window?.baseline_usd,spent);
  assert.equal(b.snapshot().additional_estimated_krw,0);
  const after=await readFile(path,'utf8');assert.ok(after.startsWith(before));
  b.approveAdditionalKrw('explicit-user-7000',7000,2000);assert.equal(await readFile(path,'utf8'),after);
  assert.throws(()=>b.approveAdditionalKrw('explicit-user-7000',8000,2000),BudgetError);
  for(const [amount,rate]of [[-1,2000],[7000,0],[NaN,2000],[7000,Infinity]])assert.throws(()=>b.approveAdditionalKrw('invalid',amount,rate),BudgetError);
  const pending=b.reserve(model,1000,1000);assert.throws(()=>b.approveAdditionalKrw('while-pending',7000,2000),BudgetError);
  b.settle(pending,model,{promptTokenCount:1000,candidatesTokenCount:1000,totalTokenCount:2000});b.close();
  const reopened=new Budget(path);try{reopened.capAdditionalKrw(1000,2000);reopened.approveAdditionalKrw('explicit-user-7000',7000,2000);
    assert.equal(reopened.spent,spent*2);assert.equal(reopened.limit,spent+3.5);
    assert.throws(()=>reopened.reserve(model,5_000_000,1),BudgetError);
    reopened.block('usage_unavailable');assert.throws(()=>reopened.approveAdditionalKrw('cannot-unblock',7000,2000),BudgetError);
  }finally{reopened.close();}
  const other=await budget(),otherPath=other.path;other.capAdditionalKrw(10,2000);other.approveAdditionalKrw('once',7000,2000);other.close();
  const grant=JSON.parse((await readFile(otherPath,'utf8')).trim().split('\n').at(-1)!);
  await appendFile(otherPath,JSON.stringify(grant)+'\n');assert.throws(()=>new Budget(otherPath),BudgetError);
  const nearCap=await budget(),nearPath=nearCap.path;nearCap.capAdditionalKrw(20000,2000);
  const charge=nearCap.reserve(model,13_000_000,1);
  nearCap.settle(charge,model,{promptTokenCount:13_000_000,candidatesTokenCount:1,totalTokenCount:13_000_001});
  const baseline=nearCap.spent;nearCap.approveAdditionalKrw('beyond-initial-cap',7000,2000);nearCap.close();
  const extended=new Budget(nearPath);try{assert.ok(extended.limit>10);assert.equal(extended.limit,baseline+3.5);
    assert.equal(extended.spent,baseline);assert.ok(Math.abs(extended.remaining-3.5)<1e-9);
  }finally{extended.close();}
});
test('reservation overrun blocks subsequent calls',async()=>{
  const b=await budget();try{
    const id=b.reserve(model,1,1);
    assert.throws(()=>b.settle(id,model,{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110}),BudgetError);
    assert.equal(b.blocked,true);assert.throws(()=>b.reserveUsd(model,1),BudgetError);
  }finally{b.close();}
});
