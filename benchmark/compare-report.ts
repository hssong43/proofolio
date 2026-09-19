// Offline comparison accounting. Provider/session counters only; no tokenizer estimates or paid calls.
import {readFileSync,readdirSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {sha256} from '../src/pipeline.ts';
import {usageCost} from '../src/llm.ts';
import {QuestionDrafts} from '../src/schema.ts';
import {questionErrors,questionFocusErrors} from '../src/questions.ts';
import {responseUsage} from '../src/benchmark.ts';
import {assertSameInput} from './writer-input.ts';

export function sessionCounters(rows:any[]) {
  const contexts=rows.filter(r=>r.type==='turn_context');
  const events=rows.filter(r=>r.type==='event_msg'&&r.payload?.type==='token_count'&&r.payload?.info);
  const complete=rows.find(r=>r.type==='event_msg'&&r.payload?.type==='task_complete');
  const verified=!!complete&&contexts.length>0&&contexts.every(r=>r.payload.model==='gpt-5.6-luna'&&r.payload.effort==='high');
  const usage=verified?events.at(-1)?.payload.info.total_token_usage:null;
  // Missing fields are not zero. Never add cumulative snapshots or add reasoning twice.
  const value=(key:string)=>Number.isSafeInteger(usage?.[key])&&usage[key]>=0?usage[key]:null;
  const input=value('input_tokens'),output=value('output_tokens'),reasoning=value('reasoning_output_tokens');
  return {verified,usage_status:usage?'observed_dedicated_session_counters':'unverified',input_tokens:input,
    output_tokens_including_reasoning:output,reasoning_tokens:reasoning,
    output_tokens_excluding_reasoning:output!==null&&reasoning!==null&&reasoning<=output?output-reasoning:null,
    cached_input_tokens:value('cached_input_tokens'),cache_write_input_tokens:value('cache_write_input_tokens'),total_tokens:value('total_tokens'),
    usage_timestamp:verified?events.at(-1)?.timestamp??null:null,observed_token_updates:verified?events.length:null,
    elapsed_ms:complete?Date.parse(complete.timestamp)-Date.parse(rows[0].timestamp):null};
}
export function assessFirstDraft(draft:any,audit:any[]|null,source:any){
  const parsed=QuestionDrafts.safeParse(draft),count=Array.isArray(draft?.questions)?draft.questions.length:0;
  if(audit&&audit.length!==count)throw new Error('First draft audit count mismatch.');
  const grounded=(q:any)=>q.grounded===true&&q.unsupported_premise===false&&q.wrong_page_or_evidence===false&&q.duplicate===false;
  const sourceGrounded=audit?audit.filter(grounded).length:null;
  if(!parsed.success)return {questions:count,passed:0,source_grounded:sourceGrounded,schema_valid:false,local_errors:parsed.error.issues,audit};
  const seenIds=new Set<string>(),seenText=new Set<string>();
  const local=parsed.data.questions.map((q,index)=>{
    const original=source.evidence.find((e:any)=>e.id===q.evidence_id),linked=original?{...original,anchors:q.anchor_indices.map(i=>original.anchors[i-1]).filter(Boolean)}:undefined;
    const errors=questionErrors(q,linked,seenIds,seenText);
    if(!linked||linked.anchors.length!==q.anchor_indices.length)errors.push('unknown_question_anchor');
    if(linked)errors.push(...questionFocusErrors(q,linked,(source.selected_points??source.analysis_plan.selected_points).find((p:any)=>p.id===linked.focus_target_id)));
    seenIds.add(q.evidence_id);seenText.add(q.question.normalize('NFC').replace(/[\p{P}\p{S}\s]/gu,''));
    return {index:index+1,errors};
  });
  return {questions:count,passed:audit?local.filter((c,i)=>!c.errors.length&&grounded(audit[i])).length:null,
    source_grounded:sourceGrounded,schema_valid:true,local_errors:local,audit};
}
export function compareJsonWriters(comparison:string,geminiRun:string,claudeRun:string){
  if(![comparison,geminiRun,claudeRun].every(v=>/^[a-z0-9-]+$/.test(v)))throw new Error('Invalid comparison/run ID.');
  const json=(p:string)=>JSON.parse(readFileSync(p,'utf8')),base='output/benchmark/runs/';
  const runs=[geminiRun,claudeRun].map(id=>json(base+id+'/run.json'));
  if(runs[0].question_model!=='gemini-3.1-pro-preview'||runs[1].question_model!=='claude-opus-5'||
    runs.some(r=>r.mode!=='question_stage_only'||!r.evidence_only)||!runs[0].freeze_sha256||runs[0].freeze_sha256!==runs[1].freeze_sha256||
    JSON.stringify(runs[0].documents)!==JSON.stringify(runs[1].documents))throw new Error('Writer comparison configuration mismatch.');
  const documents=runs[0].documents.map((id:string)=>{
    const dirs=[geminiRun,claudeRun].map(run=>base+run+'/'+id);
    const inputs=dirs.map(dir=>existsSync(dir+'/first-writer-input.json')?json(dir+'/first-writer-input.json'):null);
    if(inputs.every(Boolean))assertSameInput(inputs[0],inputs[1]);
    const sources=dirs.map(dir=>existsSync(dir+'/source-manifest.json')?json(dir+'/source-manifest.json'):null);
    if(sources.every(Boolean)&&sources[0].source_result_sha256!==sources[1].source_result_sha256)throw new Error('Different upstream evidence: '+id);
    const sides=dirs.map((dir,index)=>{
      const files=readdirSync(dir).filter(n=>/^raw-.*-QuestionSet.json$/.test(n)).sort(),file=files[0];
      if(!file)return {model:runs[index].question_model,status:'no_writer_response',
        failure:existsSync(dir+'/error.json')?json(dir+'/error.json'):null,first_draft:null,usage:null,cost_per_passed_question_usd:null};
      if(!inputs[index]||!sources[index])throw new Error('Writer response has no captured input/source: '+id);
      assertSameInput(inputs[index],inputs[index]);
      const raw=json(dir+'/'+file);let draft:unknown=null;
      if(raw._request_model!==runs[index].question_model)throw new Error('Unexpected writer model.');
      try{const parts=index===0?raw.candidates?.[0]?.content?.parts:raw.content;
        const text=parts.filter((p:any)=>index===0?p.text&&!p.thought:p.type==='text').map((p:any)=>p.text).join('');draft=JSON.parse(text);
      }catch{ /* Preserve malformed first responses as failures, never use the repaired draft. */ }
      const auditFile=dir+'/first-draft-audit.json',audit=existsSync(auditFile)?json(auditFile):null;
      if(audit&&(audit.reviewer!=='Codex visual inspection; not a human expert'||audit.raw_sha256!==sha256(readFileSync(dir+'/'+file))||
        !Array.isArray(audit.questions)||audit.questions.some((q:any,i:number)=>q.index!==i+1)))throw new Error('First draft audit identity/hash mismatch.');
      const assessed=assessFirstDraft(draft,audit?.questions??null,sources[index]),usage=responseUsage([raw],runs[index].question_model);
      const complete=index===0?raw.candidates?.[0]?.finishReason==='STOP':raw.stop_reason==='end_turn';
      if(!complete)assessed.passed=0;
      const metrics=existsSync(dir+'/metrics.json')?json(dir+'/metrics.json'):null;
      const final=existsSync(base+[geminiRun,claudeRun][index]+'/report.json')?json(base+[geminiRun,claudeRun][index]+'/report.json').documents.find((d:any)=>d.id===id):null;
      return {model:runs[index].question_model,response_complete:complete,first_draft:assessed,original_questions:draft,raw_file:dir+'/'+file,usage,
        first_draft_elapsed_ms:metrics?.stages.find((s:any)=>s.stage==='QuestionSet')?.elapsed_ms??null,
        first_draft_application_retries:0,application_http_retries:0,
        application_schema_retries:metrics?metrics.stages.filter((s:any)=>s.attempt>1).length:null,provider_retries:null,
        cost_per_passed_question_usd:assessed.passed&&usage.cost_usd!==null?usage.cost_usd/assessed.passed:null,final_workflow:final};
    });
    return {id,track:sources[0]?.track??sources[1]?.track??null,inputs_match:inputs.every(Boolean)?true:null,
      input_sha256:inputs[0]?.sha256??null,source_result_sha256:sources[0]?.source_result_sha256??null,gemini:sides[0],claude:sides[1]};
  });
  mkdirSync('output/benchmark/comparisons',{recursive:true,mode:0o700});
  const root='output/benchmark/comparisons/'+comparison;mkdirSync(root,{mode:0o700});
  const result={comparison,created_at:new Date().toISOString(),scope:'same evidence JSON, first drafts; final workflow reported separately',
    conclusion:'No automatic model adoption. Missing source audits are not passes; provider-internal retries are unconfirmed.',documents};
  writeFileSync(root+'/report.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
function main(){
const {values:v}=parseArgs({options:{comparison:{type:'string'},'session-dir':{type:'string'},'gemini-run':{type:'string'},'claude-run':{type:'string'}}});
if(v['gemini-run']||v['claude-run'])return compareJsonWriters(v.comparison??'',v['gemini-run']??'',v['claude-run']??'');
if(!v.comparison||!/^[a-z0-9-]+$/.test(v.comparison)||!v['session-dir'])throw new Error('Require --comparison ID --session-dir DIRECTORY.');
const root=resolve(`output/benchmark/comparisons/${v.comparison}`),protocol=JSON.parse(readFileSync('benchmark/luna-pro-comparison.json','utf8'));
if(protocol.comparison!==v.comparison)throw new Error('Protocol mismatch.');
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const sessions=new Map<string,{path:string;rows:any[]}>();
for(const name of readdirSync(v['session-dir']).filter(n=>n.endsWith('.jsonl'))){
  const path=join(v['session-dir'],name),data=readFileSync(path,'utf8'),first=JSON.parse(data.slice(0,data.indexOf('\n')));
  const agent=first.payload?.source?.subagent?.thread_spawn?.agent_path;
  if(typeof agent!=='string'||!agent.startsWith('/root/luna_questions_'))continue;
  const id=agent.slice('/root/luna_questions_'.length).replaceAll('_','-');
  if(!protocol.documents.includes(id))continue;
  if(sessions.has(id))throw new Error('Ambiguous Luna session for '+id);
  sessions.set(id,{path,rows:data.trim().split('\n').map(s=>JSON.parse(s))});
}
const rows=protocol.documents.map((id:string)=>{
  const dir=join(root,id),manifest=json(join(dir,'manifest.json')),runDir=resolve(`output/benchmark/runs/${manifest.from}/${id}`);
  const resultPath=join(runDir,'result.json'),result=json(resultPath),files=readdirSync(runDir).filter(n=>/^raw-.*-QuestionSet.json$/.test(n)).sort();
  if(sha256(readFileSync(resultPath))!==manifest.source_result_sha256)throw new Error('Source result changed: '+id);
  const inputPath=join(dir,'input.json'),input=json(inputPath);
  if(sha256(readFileSync(inputPath))!==manifest.input_sha256||input.images.some((i:any)=>sha256(readFileSync(i.path))!==i.sha256))throw new Error('Comparison input changed: '+id);
  const rawPath=join(runDir,files[0]),raw=json(rawPath),lunaPath=join(dir,'luna-raw.json');
  const geminiDraft=JSON.parse(raw.candidates[0].content.parts.filter((p:any)=>p.text&&!p.thought).map((p:any)=>p.text).join(''));
  const audit=json(join(dir,'first-draft-audit.json'));
  if(audit.gemini_raw_sha256!==sha256(readFileSync(rawPath))||audit.luna_raw_sha256!==sha256(readFileSync(lunaPath)))throw new Error('Audit hash mismatch: '+id);
  const check=(draft:any,side:'gemini'|'luna')=>{
    return assessFirstDraft(draft,audit[side],result);
  };
  const gemini=check(geminiDraft,'gemini'),luna=check(json(lunaPath),'luna'),session=sessions.get(id);
  const counters=sessionCounters(session?.rows??[]),execution=json(join(dir,'luna-execution.json'));
  const firstCost=usageCost(raw._request_model,raw.usageMetadata);
  const stageUsage=result.metrics.usage.filter((u:any)=>u.stage==='QuestionSet'||u.stage==='QuestionReviews');
  const finalAudit=json(join(runDir,'source-audit.json'));
  if(finalAudit.result_sha256!==manifest.source_result_sha256)throw new Error('Final audit mismatch: '+id);
  const finalPassed=finalAudit.questions.filter((q:any)=>q.grounded&&!q.unsupported_premise&&!q.wrong_page_or_evidence&&!q.duplicate).length;
  return {id,track:manifest.track,input_sha256:manifest.input_sha256,selected_pages:manifest.selected_pages,
    gemini:{...gemini,model:raw._request_model,input_tokens:raw.usageMetadata.promptTokenCount??null,
      output_tokens:raw.usageMetadata.candidatesTokenCount??null,reasoning_tokens:raw.usageMetadata.thoughtsTokenCount??null,
      total_tokens:raw.usageMetadata.totalTokenCount??null,first_draft_elapsed_ms:result.metrics.stages.find((s:any)=>s.stage==='QuestionSet')?.elapsed_ms??null,
      cached_input_tokens:raw.usageMetadata.cachedContentTokenCount??null,usage_source:rawPath,
      first_draft_api_cost_usd:firstCost,cost_per_passed_question_usd:gemini.passed?firstCost/gemini.passed:null,
      cost_per_pass_status:gemini.passed?'usage_based_api_estimate':'undefined_no_passes',first_draft_application_retries:0,
      workflow_question_requests:files.length,workflow_question_batches:result.metrics.stages.filter((s:any)=>s.stage==='QuestionSet'&&s.attempt===1).length,
      workflow_schema_retries:result.metrics.stages.filter((s:any)=>['QuestionSet','QuestionReviews'].includes(s.stage)&&s.attempt>1).length,
      workflow_all_stage_schema_retries:result.metrics.stages.filter((s:any)=>s.attempt>1).length,application_http_retries:0,provider_retries:null,
      workflow_question_usage:stageUsage,workflow_question_stage_cost_usd:stageUsage.reduce((n:number,u:any)=>n+usageCost(u.model,u),0),
      workflow_total_api_cost_usd:result.metrics.estimated_cost_usd,workflow_final_questions:result.questions.length,
      workflow_passed_questions:finalPassed,workflow_cost_per_passed_question_usd:finalPassed?result.metrics.estimated_cost_usd/finalPassed:null},
    luna:{...luna,...counters,model:counters.verified?'gpt-5.6-luna':null,reasoning_effort:counters.verified?'high':null,
      usage_source:session?.path??null,
      application_retries:execution.application_retries,provider_retries:null,generation_batches:execution.generation_batches,
      actual_cost_usd:null,cost_per_passed_question_usd:null,cost_status:'unverified_Codex_billing_not_API_usage'}};
});
const report={comparison:v.comparison,created_at:new Date().toISOString(),protocol,documents:rows,
  conclusion:'Quality of first drafts only. No automatic provider switch. Luna actual monetary cost is unverified; tokens are never estimated.'};
writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
const questions=['# 수정하지 않은 첫 질문 비교','',
  '같은 검증 근거와 페이지 이미지. Gemini 첫 API 응답과 Luna High 첫 초안이며, 재시도 후 최종 Gemini 질문과 다르다. 판정은 별도 Codex 원문 검수이며 전문가 평가가 아니다.',''];
for(const row of rows){
  const raw=json(row.gemini.usage_source);
  const geminiDraft=JSON.parse(raw.candidates[0].content.parts.filter((p:any)=>p.text&&!p.thought).map((p:any)=>p.text).join(''));
  const lunaDraft=json(join(root,row.id,'luna-raw.json'));
  questions.push(`## ${row.id} — 원본 페이지 ${row.selected_pages.join(', ')}`,'');
  for(const [side,draft] of [['gemini',geminiDraft],['luna',lunaDraft]] as const){
    const result=row[side];questions.push(`### ${side} — 통과 ${result.passed}/${result.questions}, 스키마 ${result.schema_valid?'통과':'실패'}`,'');
    draft.questions.forEach((q:any,i:number)=>questions.push(`#### 질문 ${i+1}`,'',q.question,'',`의도: ${q.intent}`,'',
      `답변 확인 항목: ${q.listen_for.join(' / ')}`,'',`근거: ${q.evidence_id}; 앵커 ${q.anchor_indices.join(', ')}`,'',
      `원문 검수: ${result.audit[i].note}`,''));
  }
}
writeFileSync(join(root,'questions.md'),questions.join('\n')+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(rows.map((r:any)=>({id:r.id,gemini:`${r.gemini.passed}/${r.gemini.questions}`,luna:`${r.luna.passed}/${r.luna.questions}`,luna_usage:r.luna.usage_status})),null,2));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main();
