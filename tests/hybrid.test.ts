import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as z from 'zod';
import {writerInput,assertSameInput} from '../benchmark/writer-input.ts';
import {modelRequest} from '../src/questions.ts';
import {freshMetrics,SchemaValidationError} from '../src/llm.ts';
import {Audit,responseUsage,pilotPass,tokenTotals} from '../src/benchmark.ts';
const OPUS_MODEL='claude-opus-5'; // Historical saved-report fixture, not an API route.
import {assessFirstDraft} from '../benchmark/compare-report.ts';

test('hybrid comparison hashes identical JSON-only writer inputs, not provider names',()=>{
  const request={kind:'QuestionSet',model:'gemini-3.1-pro-preview',schema:z.object({value:z.string()}),prompt:'검증된 근거',thinkingLevel:'MEDIUM' as const,maxOutputTokens:16384};
  const gemini=writerInput(request,true),opus=writerInput({...request,model:OPUS_MODEL},true);
  assertSameInput(gemini,opus);assert.deepEqual(opus.images,[]);
  assert.throws(()=>writerInput({...request,images:[['PDF',Buffer.alloc(1)]]},true));
  assert.throws(()=>writerInput({...request,pdf:Buffer.alloc(1)},true));
  assert.throws(()=>assertSameInput(writerInput({...request,prompt:'changed'},true),opus));
  assert.throws(()=>assertSameInput(gemini,{...opus,prompt:'tampered'}));
  assert.throws(()=>assertSameInput({...gemini,prompt:'tampered'},opus));
});
test('first-draft comparison cannot count schema or unchecked source claims as passed',()=>{
  const source={evidence:[],selected_points:[]};
  assert.equal(assessFirstDraft({questions:[]},null,source).passed,null);
  assert.equal(assessFirstDraft({questions:'not an array'},null,source).schema_valid,false);
  assert.throws(()=>assessFirstDraft({questions:[]},[{}],source));
});
test('production/replay request path has one schema retry, MEDIUM and fixed writer ceiling',async()=>{
  const stats=freshMetrics(),seen:any[]=[],schema=z.object({value:z.string()});
  const request=modelRequest(async r=>{seen.push(r);return seen.length===1?{}:{value:'ok'};},stats,
    {model:'gemini-3.1-pro-preview',questionModel:OPUS_MODEL,reviewModel:'gemini-3.1-pro-preview',questionMaxOutputTokens:16384});
  assert.deepEqual(await request('QuestionSet',schema,{prompt:'source'}),{value:'ok'});
  assert.equal(seen.length,2);assert.equal(stats.stages[1].attempt,2);
  assert.ok(seen.every(r=>r.model===OPUS_MODEL&&r.maxOutputTokens===16384&&r.thinkingLevel==='MEDIUM'));
  await request('QuestionReviews',schema,{prompt:'review'});assert.equal(seen[2].model,'gemini-3.1-pro-preview');
  assert.equal(seen[2].maxOutputTokens,32768);
  let calls=0;
  await assert.rejects(modelRequest(async()=>{calls++;throw new SchemaValidationError('bad');},freshMetrics(),{model:OPUS_MODEL})('QuestionSet',schema,{prompt:'source'}));
  assert.equal(calls,2);
});
test('request capture, cancellation and API failure cannot trigger new or automatic retry calls',async()=>{
  let calls=0;const schema=z.object({value:z.string()}),capture=new Error('offline capture'),stats=freshMetrics();
  const request=modelRequest(async()=>{calls++;return {value:'ok'};},stats,{model:OPUS_MODEL,onRequest:()=>{throw capture;}});
  await assert.rejects(request('QuestionSet',schema,{prompt:'source'}),e=>e===capture);assert.equal(calls,0);assert.equal(stats.model_calls,0);
  await assert.rejects(modelRequest(async()=>{calls++;throw new Error('HTTP 429');},stats,{model:OPUS_MODEL})('QuestionSet',schema,{prompt:'source'}));
  assert.equal(calls,1);
  await assert.rejects(modelRequest(async()=>{calls++;return {};},stats,{model:OPUS_MODEL,signal:AbortSignal.abort()})('QuestionSet',schema,{prompt:'source'}));
  assert.equal(calls,1);
});
test('hybrid usage separates providers, includes thinking once and preserves unknown counters',()=>{
  const gemini={_request_model:'gemini-3.1-pro-preview',usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130}};
  const opus={_request_model:OPUS_MODEL,usage:{input_tokens:100,output_tokens:30,cache_read_input_tokens:20}};
  const result=responseUsage([gemini,opus],'gemini-3.1-pro-preview');
  assert.deepEqual(result.tokens,{input:220,output:50,thinking:null,cached:20,total:280});
  assert.equal(result.unknown_usage_responses,0);assert.equal(result.providers.vertex.output_includes_thinking,true);
  assert.equal(result.providers.vertex.cost_usd,.00126);assert.equal(result.providers.gemini.cost_usd,.00056);
  assert.equal(responseUsage([{_request_model:OPUS_MODEL}],OPUS_MODEL).cost_usd,null);
  assert.equal(responseUsage([{_request_model:OPUS_MODEL}],OPUS_MODEL).tokens.input,null);
  assert.equal(responseUsage([{_request_model:OPUS_MODEL}],OPUS_MODEL).tokens.cached,null);
  const pending=responseUsage([gemini],'gemini-3.1-pro-preview',['vertex']);
  assert.equal(pending.tokens.input,null);assert.equal(pending.cost_usd,null);
  assert.equal(pending.providers.vertex.unresolved_call,true);assert.equal(pending.providers.vertex.tokens.output,null);
  assert.equal(pending.providers.gemini.tokens.input,100);
  assert.equal(tokenTotals([{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}]).thinking,null);
});
test('pilot needs independent source/coverage inspection, not automatic ready',()=>{
  const result={questions:[1,2,3],quality:{status:'ready'}};
  const audit=Audit.parse({reviewer:'Codex visual inspection; not a human expert',result_sha256:'hash',
    questions:[1,2,3].map(i=>({id:'q'+i,grounded:true,wrong_page_or_evidence:false,unsupported_premise:false,duplicate:false,note:'source checked'})),
    bad_boxes:[],covered_gold_points:[],notes:[],selected_points_complete:true,final_source_errors:[],substantive_questions:2});
  assert.equal(pilotPass(result,null),false);assert.equal(pilotPass(result,audit),true);
  assert.equal(pilotPass(result,{...audit,selected_points_complete:undefined}),false);
  assert.equal(pilotPass(result,{...audit,final_source_errors:['wrong box']}),false);
  assert.equal(pilotPass(result,{...audit,questions:audit.questions.map((q,i)=>({...q,duplicate:i===1}))}),false);
});
test('OpenRouter reports API cost and reasoning once, never Gemini price estimates or missing usage as zero',()=>{
  const raw={_request_provider:'openrouter',_request_model:'anthropic/claude-opus-5',
    usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130,cost:.01,completion_tokens_details:{reasoning_tokens:10}}};
  const r=responseUsage([raw],raw._request_model);
  assert.equal(r.cost_usd,.01);assert.deepEqual(r.tokens,{input:100,output:30,total:130,thinking:10,cached:null});
  assert.equal(r.providers.openrouter.output_includes_thinking,true);
  assert.equal(responseUsage([{...raw,usage:{...raw.usage,cost:null}}],raw._request_model).cost_usd,null);
  assert.equal(responseUsage([raw],raw._request_model,['openrouter']).cost_usd,null);
});
test('comparison retains preflight failures and unattempted documents without inventing equal inputs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'proofolio-hybrid-report-'));
  for(const [run,model]of [['gemini','gemini-3.1-pro-preview'],['claude',OPUS_MODEL]]){
    const root=join(dir,'output/benchmark/runs',run);mkdirSync(root,{recursive:true});
    writeFileSync(join(root,'run.json'),JSON.stringify({mode:'question_stage_only',evidence_only:true,freeze_sha256:'same',question_model:model,documents:['d-shuu','m-damyul']}));
    for(const id of ['d-shuu','m-damyul']){
      mkdirSync(join(root,id));writeFileSync(join(root,id,'error.json'),JSON.stringify({status:id==='d-shuu'?'failed':'unattempted_after_failure',error:'HTTP 429'}));
    }
  }
  const script=`globalThis.fetch=()=>{throw new Error('No network allowed')};
    const {compareJsonWriters}=await import(${JSON.stringify(new URL('../benchmark/compare-report.ts',import.meta.url).href)});
    compareJsonWriters('failed-check','gemini','claude');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(readFileSync(join(dir,'output/benchmark/comparisons/failed-check/report.json'),'utf8'));
  assert.equal(report.documents.length,2);
  assert.equal(report.documents[0].inputs_match,null);assert.equal(report.documents[0].claude.usage,null);
  assert.equal(report.documents[1].claude.failure.status,'unattempted_after_failure');
});
