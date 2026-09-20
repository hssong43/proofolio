import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeCode,validateCodeFiles} from './coding.ts';
import {checkDestinations} from './cli.ts';
import {Budget,freshMetrics} from './llm.ts';
import {loadRuntimeEnv} from './env.ts';
import {openRouterSession} from './openrouter.ts';

const {values:v,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string'},'budget-ledger':{type:'string'},'max-cost-usd':{type:'string'},'max-questions':{type:'string',default:'10'}}});
if(positionals.length!==1||!v.output||!v['budget-ledger']||!v['max-cost-usd'])throw new Error('INPUT.json --output NEW_RESULT.json --budget-ledger EXISTING_LEDGER --max-cost-usd APPROVED_LIMIT');
const env:NodeJS.ProcessEnv={};loadRuntimeEnv(resolve(dirname(fileURLToPath(import.meta.url)),'..'),env);
const input=JSON.parse(readFileSync(positionals[0],'utf8')),stats=freshMetrics(),limit=Number(v['max-cost-usd']);
if(!Number.isFinite(limit)||limit<=0)throw new Error('승인된 한도가 필요해요.');
const output=resolve(v.output);mkdirSync(dirname(output),{recursive:true});
checkDestinations([output,output+'.raw',output+'.error.json',output+'.budget.json']);
validateCodeFiles(input.files);
if(!existsSync(v['budget-ledger']))throw new Error('기존 승인 원장이 필요해요.');
const key=env.OPENROUTER_API_KEY||'';
if(!key)throw new Error('OPENROUTER_API_KEY가 필요해요.');
const budget=new Budget(v['budget-ledger'],limit,'openrouter'),started=performance.now();
mkdirSync(output+'.raw',{mode:0o700});let responseIndex=0;
const controller=new AbortController();process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
const session=openRouterSession(key,stats,budget,{signal:controller.signal,onResponse:(kind,raw,model)=>{
  writeFileSync(resolve(output+'.raw',`${++responseIndex}.json`),JSON.stringify({kind,model,raw}).replaceAll(key,'[REDACTED]'),{flag:'wx',mode:0o600});
}});
try{
  console.log(JSON.stringify({type:'stage',data:{stage:'questions'}}));
  stats.model_calls++;
  const client_result=await analyzeCode(input.files,input.name,session.generate,Number(v['max-questions']));
  stats.total_ms=Math.round(performance.now()-started);client_result.estimatedCostUsd=stats.estimated_cost_usd;
  writeFileSync(output,JSON.stringify({schema_version:'coding-0.1',client_result,metrics:stats,commit:input.commit??null},null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({type:'complete',questions:client_result.questions.length,cost_usd:stats.estimated_cost_usd}));
}catch(e){const message=(e as Error).message.replaceAll(key,'[REDACTED]');
  writeFileSync(output+'.error.json',JSON.stringify({message,metrics:stats}),{flag:'wx',mode:0o600});console.error('코딩 분석 실패: '+message);process.exitCode=1;}
finally{await session.close();writeFileSync(output+'.budget.json',JSON.stringify(budget.snapshot(),null,2),{flag:'wx',mode:0o600});budget.close();}
