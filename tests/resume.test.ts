import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {priorAction,resumePlan,reserveWithin} from '../benchmark/resume.ts';
import {Budget,BudgetError} from '../src/gemini.ts';

test('resume reuses completed or failed cases and never overwrites an existing run',()=>{
  const dir=mkdtempSync(join(tmpdir(),'portfolio-resume-'));
  assert.equal(priorAction(dir),'resume');
  writeFileSync(join(dir,'error.json'),JSON.stringify({status:'unattempted_budget'}));assert.equal(priorAction(dir),'resume');
  writeFileSync(join(dir,'error.json'),JSON.stringify({status:'interrupted'}));assert.equal(priorAction(dir),'resume');
  writeFileSync(join(dir,'error.json'),JSON.stringify({status:'failed'}));assert.equal(priorAction(dir),'reuse');
  writeFileSync(join(dir,'result.json'),'{}');assert.equal(priorAction(dir),'reuse');
  assert.throws(()=>resumePlan('../unsafe','safe'));
  assert.throws(()=>resumePlan('final-01','final-01'));
  // Original private PDF results are intentionally not redistributed with the package.
  if(existsSync('output/benchmark/runs/final-01/run.json')){
    // v0.6 must never resume or relabel the frozen v0.5 evaluation as the new core.
    assert.throws(()=>resumePlan('final-01','resume-test-unused'),/Frozen code/);
  }
});
test('additional-spend guard includes pending reservations and never exceeds the original budget',()=>{
  const b=new Budget(join(mkdtempSync(join(tmpdir(),'portfolio-spend-')),'ledger'),10),reserve=b.reserve;
  try{
    const id=reserveWithin(b,.01,reserve,'gemini-3.8-flash',1000,1000);
    assert.ok(id);assert.equal(b.reserved,.0045);
    assert.throws(()=>reserveWithin(b,.008,reserve,'gemini-3.8-flash',1000,1000),BudgetError);
    assert.equal(b.pending.size,1);
    assert.throws(()=>reserveWithin(b,11,reserve,'gemini-3.8-flash',1,1),BudgetError);
    assert.throws(()=>reserveWithin(b,.01,reserve,'gemini-3.8-flash',-1,1),BudgetError);
    b.settle(id,'gemini-3.8-flash',{promptTokenCount:1000,candidatesTokenCount:1000,totalTokenCount:2000});
    assert.throws(()=>reserveWithin(b,.008,reserve,'gemini-3.8-flash',1000,1000),BudgetError);
  }finally{b.close();}
});
