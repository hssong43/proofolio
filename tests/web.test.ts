import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {executionBudget,loadEnv} from '../src/env.ts';
import {runCli} from '../src/cli.ts';
import {main as benchmarkMain} from '../src/benchmark.ts';
import {analyzePdf} from '../src/pipeline.ts';
import {DEFAULT_MAX_QUESTIONS} from '../src/questions.ts';
import {analysisArgs,toClientResult,ROOT,sameOrigin} from '../web/lib/server/runner.ts';

test('same-origin upload uses the browser Host, not Next internal localhost, and rejects cross-site requests',()=>{
  const check=(origin?:string,site?:string)=>sameOrigin(new Request('http://localhost:3100/api/analyze',{
    headers:{host:'127.0.0.1:3100',...(origin?{origin}:{}),...(site?{'sec-fetch-site':site}:{})}}));
  assert.equal(check('http://127.0.0.1:3100'),true);
  for(const origin of ['https://example.invalid','http://127.0.0.1:3101','null','http://127.0.0.1:3100/path'])assert.equal(check(origin),false);
  assert.equal(check(undefined,'cross-site'),false);assert.equal(check(undefined,'same-origin'),true);
});

test('web and CLI share OpenRouter, the same ledger, explicit spending and the five-question ceiling',()=>{
  const env={PROOFOLIO_MAX_COST_USD:'10'},run='00000000-0000-4000-8000-000000000001';
  const args=analysisArgs(run,'design',5,env),value=(flag:string)=>args[args.indexOf(flag)+1];
  assert.equal(ROOT,resolve('.'));
  assert.equal(value('--provider'),'openrouter');assert.equal(value('--max-cost-usd'),'10');
  assert.equal(value('--budget-ledger'),executionBudget(ROOT,env).ledger);
  assert.equal(value('--max-questions'),String(DEFAULT_MAX_QUESTIONS));
  assert.throws(()=>analysisArgs(run,'design',10,env));
  assert.throws(()=>analysisArgs('../escape','design',5,env));
  for(const limit of [undefined,'0','-1','11','NaN','Infinity'])
    assert.throws(()=>analysisArgs(run,'design',5,{PROOFOLIO_MAX_COST_USD:limit}));
  for(const ledger of ['output/api-budget.jsonl','output/web/api-budget.jsonl','output/benchmark/api-budget.jsonl','output/gcp-opus-budget.jsonl'])
    assert.throws(()=>executionBudget(ROOT,{...env,PROOFOLIO_BUDGET_LEDGER:ledger}));
  const example:NodeJS.ProcessEnv={};loadEnv(resolve('.env.example'),example);
  assert.throws(()=>executionBudget(ROOT,example));assert.equal(example.GEMINI_API_KEY,undefined);
});
test('removed direct providers fail before reading a PDF, creating a run or contacting a model',async()=>{
  for(const provider of ['gemini','vertex']){
    const errors:string[]=[];
    assert.equal(await runCli(['missing.pdf','--track','design','--provider',provider],{stderr:s=>errors.push(s)}),1);
    assert.match(errors[0],/OpenRouter/);
    await assert.rejects(benchmarkMain(['run','--provider',provider]),/OpenRouter/);
    await assert.rejects(analyzePdf(Buffer.from('not pdf'),{track:'design',model:'gemini-test',provider:provider as 'openrouter'}),/OpenRouter/);
  }
  for(const path of ['src/gemini.ts','src/vertex.ts','src/check-vertex.ts','benchmark/resume.ts','benchmark/requestion.ts'])assert.equal(existsSync(path),false);
  assert.equal('google-auth-library' in JSON.parse(readFileSync('package.json','utf8')).dependencies,false);
});
test('UI adapter preserves multiline source quotes, whole questions, checked pages and quality failures',()=>{
  const quote='첫째 줄\n둘째 줄',prompt='선택 기준을 설명해 주세요.\n실제로 검증했다면 방법도 알려 주세요.';
  const raw={status:'needs_review',quality:{issues:['selected_points_uncovered']},document:{page_count:20},
    document_map:{projects:[{key:'p1',title:'실제 프로젝트',pages:[2,3]}]},analysis_plan:{selected_project_keys:['p1']},
    evidence:[{}],questions:[{id:'q1',question:'원문: '+quote+'\n'+prompt,intent:'원문 기반 확인',listen_for:['의사결정 기준'],
      answer_target:'p2:r1',project_key:'p1',anchors:[{page:3,quote},{page:2,quote}]}],metrics:{estimated_cost_usd:.1},max_questions:5};
  const client=toClientResult(raw);
  assert.equal(client.questions[0].prompt,prompt);assert.deepEqual(client.questions[0].quotes,[quote]);
  assert.deepEqual(client.questions[0].pages,[2,3]);assert.equal(client.status,'needs_review');
  assert.deepEqual(client.qualityIssues,['selected_points_uncovered']);assert.equal(client.maxQuestions,5);
  raw.questions[0].anchors=[{page:2,quote:''}];raw.questions[0].question='연결된 시각 자료를 기준으로 답해 주세요.\n'+prompt;
  const visual=toClientResult(raw);assert.equal(visual.questions[0].prompt,prompt);assert.equal(visual.questions[0].notes.length,1);
});
test('saved two-PDF results remain byte-for-byte inputs to the UI, not regenerated questions',{
  skip:!['d-shuu','m-damyul'].every(id=>existsSync(`output/benchmark/runs/openrouter-pilot-02/${id}/result.json`)),
},()=>{
  for(const id of ['d-shuu','m-damyul']){
    const path=`output/benchmark/runs/openrouter-pilot-02/${id}/result.json`;
    const raw=JSON.parse(readFileSync(path,'utf8')),client=toClientResult(raw);
    assert.equal(client.questions.length,raw.questions.length);
    for(const [i,q]of client.questions.entries()){
      assert.ok(raw.questions[i].question.endsWith(q.prompt));
      assert.deepEqual(q.pages,[...new Set<number>(raw.questions[i].anchors.map((a:{page:number})=>a.page))].sort((a,b)=>a-b));
    }
  }
});
test('web runner handles a fast local child, atomic status polling and answer storage without model calls',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'proofolio-web-runner-'));mkdirSync(resolve(root,'src'));
  const raw={status:'insufficient_evidence',quality:{issues:['fewer_than_three_questions']},document:{page_count:1},
    document_map:{projects:[]},analysis_plan:{selected_project_keys:[]},evidence:[],questions:[],metrics:{estimated_cost_usd:0}};
  writeFileSync(resolve(root,'src/cli.ts'),`import {writeFileSync} from 'node:fs';
    const args=process.argv.slice(2);if(args[args.indexOf('--provider')+1]!=='openrouter')process.exit(2);
    for(let i=0;i<20;i++)console.log(JSON.stringify({type:'stage',data:{stage:'questions'}}));
    writeFileSync(args[args.indexOf('--output')+1],${JSON.stringify(JSON.stringify(raw))});`);
  const script=`import assert from 'node:assert/strict';import {setTimeout} from 'node:timers/promises';
    globalThis.fetch=()=>{throw new Error('No model calls allowed');};
    const {startRun,readStatus,saveAnswers}=await import(${JSON.stringify(new URL('../web/lib/server/runner.ts',import.meta.url).href)});
    const run=await startRun({bytes:Buffer.from('%PDF-fixture'),fileName:'fixture.pdf',track:'design'});
    let status;for(let i=0;i<300;i++){status=await readStatus(run.runId);assert.ok(status);if(status.state==='complete'||status.state==='failed')break;await setTimeout(10);}
    assert.equal(status.state,'complete');assert.equal(status.stage,3);assert.equal(status.result.questions.length,0);
    await saveAnswers(run.runId,[]);console.log(run.runId);`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8',timeout:10000,
    env:{...process.env,PROOFOLIO_ROOT:root,PROOFOLIO_MAX_COST_USD:'10',PROOFOLIO_BUDGET_LEDGER:'output/openrouter-budget.jsonl',OPENROUTER_API_KEY:''}});
  assert.equal(result.status,0,result.stderr);
  const runId=result.stdout.trim();assert.match(runId,/^[a-f0-9-]{36}$/);
  assert.equal(existsSync(resolve(root,'output/openrouter-budget.jsonl')),false);
  assert.deepEqual(JSON.parse(readFileSync(resolve(root,'output/web/runs',runId,'answers.json'),'utf8')).answers,[]);
});
