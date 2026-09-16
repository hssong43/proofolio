import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {Corpus,Gold,codeHash,tokenTotals,trackThreshold,validateGold} from '../src/benchmark.ts';
import {selectPages} from '../src/pipeline.ts';
import {questionErrors} from '../src/questions.ts';
import type {ResolvedEvidence} from '../src/schema.ts';
import {VISUAL_PROMPT,QUESTION_PROMPT,QUESTION_REVIEW_PROMPT,EXTRACTION_RULES,REVIEW_PROMPT} from '../src/prompts.ts';

test('benchmark excludes duplicate authors, incomplete tracks and incomplete source notes',()=>{
  assert.equal(Corpus.safeParse([]).success,false);assert.equal(Gold.safeParse({id:'fake',reviewer:'human expert'}).success,false);
  assert.match(codeHash(),/^[a-f0-9]{64}$/);
});
test('benchmark counts thought tokens and permits two failures but never unchecked final premises',()=>{
  assert.deepEqual(tokenTotals([{promptTokenCount:20,candidatesTokenCount:5,thoughtsTokenCount:7,totalTokenCount:32}]),{input:20,output:5,thinking:7,cached:0,total:32});
  const good={pass:true,reviewed:true,questions:3,wrong_page_or_evidence:0,unsupported_premise:0},failed={pass:false,reviewed:false,questions:0};
  const rows=[...Array.from({length:8},()=>({...good})),failed,failed];assert.equal(trackThreshold(rows),true);
  assert.equal(trackThreshold([...rows.slice(1),failed]),false);
  assert.equal(trackThreshold([...rows.slice(0,9),{...good,pass:false,unsupported_premise:1}]),false);
  assert.equal(trackThreshold([...rows.slice(0,9),{...good,pass:false,reviewed:false}]),false);
  const corpus=Corpus.parse(JSON.parse(readFileSync('benchmark/corpus.json','utf8')));assert.equal(validateGold(corpus).length,20);
  assert.equal(Corpus.safeParse(corpus.map((s,i)=>i===1?{...s,author:corpus[0].author}:s)).success,false);
});
test('numeric questions require an exact source phrase with its subject',()=>{
  const source={question_eligible:true,anchors:[{quote:'한 타입패밀리를 3가지 타입으로 구분'}]} as ResolvedEvidence;
  const check=(question:string)=>questionErrors({evidence_id:'e',question,intent:'선택 이유 확인',listen_for:['선택 근거']},source,new Set(),new Set());
  assert.deepEqual(check('“3가지 타입”의 구분 기준은 무엇인가요?'),[]);
  assert.ok(check('“3개 타입패밀리”의 구분 기준은 무엇인가요?').length);
  assert.ok(check('“3”가지 타입패밀리의 기준은?').length);
});
test('wire-schema omissions and cross-question anchor leakage remain explicit prompt constraints',()=>{
  assert.match(VISUAL_PROMPT,/regions\.key.*r1, r2, r3/);
  assert.match(VISUAL_PROMPT,/role_basis=null이면 source_role은 반드시 unknown/);
  assert.match(QUESTION_PROMPT,/그 evidence_id의 anchors만/);
  assert.match(QUESTION_REVIEW_PROMPT,/자기 source\.anchors만/);
  assert.match(QUESTION_REVIEW_PROMPT,/listen_for만 조심스럽다고/);
  assert.match(EXTRACTION_RULES,/각 영역에 별도 anchor/);
  assert.match(REVIEW_PROMPT,/box 밖의 객체로 anchor를 보완하지 않는다/);
});
const saved='output/analysis/notefolio-349325-context-v2.json';
test('saved Python selection parity, no paid rerun',{skip:!existsSync(saved)},()=>{
  const old=JSON.parse(readFileSync(saved,'utf8'));assert.deepEqual(selectPages(old.document_map),old.analysis_plan);
});
