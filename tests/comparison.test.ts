import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionCounters} from '../benchmark/compare-report.ts';

test('Luna accounting uses final actual cumulative counters, preserves missing data and checks model/effort',()=>{
  const rows=[{type:'session_meta',timestamp:'2026-09-19T00:00:00Z'},
    {type:'turn_context',payload:{model:'gpt-5.6-luna',effort:'high'}},
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:40,output_tokens:10}}}},
    {type:'event_msg',timestamp:'2026-09-19T00:00:03Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:30,reasoning_output_tokens:20,total_tokens:130}}}},
    {type:'event_msg',timestamp:'2026-09-19T00:00:04Z',payload:{type:'task_complete'}}];
  const actual=sessionCounters(rows);
  assert.equal(actual.input_tokens,100);assert.equal(actual.total_tokens,130);
  assert.equal(actual.output_tokens_including_reasoning,30);assert.equal(actual.output_tokens_excluding_reasoning,10);
  assert.equal(actual.reasoning_tokens,20);assert.equal(actual.cached_input_tokens,null);assert.equal(actual.elapsed_ms,4000);
  assert.equal(sessionCounters(rows.slice(0,-1)).input_tokens,null);
  assert.equal(sessionCounters([...rows,{type:'turn_context',payload:{model:'different',effort:'high'}}]).input_tokens,null);
  assert.equal(sessionCounters([]).usage_status,'unverified');
});
