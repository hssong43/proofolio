import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCode,codeQuestionsFromResponse,validateCodeFiles,MAX_CODE_QUOTE} from '../src/coding.ts';

test('coding: one bounded model call, exact path/quote linking, no synthetic fill or semantic approval',async()=>{
  const quote='export function example() {\n'+('  return value; // code context\n'.repeat(20))+'}';
  assert.ok(quote.length>400 && quote.length<MAX_CODE_QUOTE);
  const files=[{path:'src/example.ts',content:quote}],candidate=(i:number)=>({prompt:`선택 기준 ${i}을 설명해주세요.`,intent:'설명',source_path:files[0].path,quote});
  const raw={summary:'실행하지 않은 코드',questions:[candidate(1),candidate(2),{...candidate(3),quote:'원문에 없는 코드'},
    {...candidate(4),source_path:'missing.ts'},candidate(1),candidate(5),candidate(6)]};
  let calls=0;
  const result=await analyzeCode(files,'synthetic',async request=>{calls++;assert.equal(request.kind,'CodingQuestions');return raw;});
  assert.equal(calls,1);assert.equal(result.questions.length,4);assert.equal(result.status,'needs_review');
  assert.deepEqual(result.qualityIssues,['coding_unreviewed','fewer_than_six_questions']);
  assert.ok(result.questions.every(q=>q.quotes[0]===quote && q.pages.length===0));
  assert.equal(codeQuestionsFromResponse(files,'test',{summary:'',questions:Array.from({length:10},(_,i)=>candidate(i))},6).questions.length,6);
  assert.throws(()=>codeQuestionsFromResponse(files,'test',raw,11));
  for(const files of [null,[null],[{path:'../.env',content:'x'}],[{path:'src/a.ts',content:'x'.repeat(24001)}],
    [{path:'src/a.ts',content:'sb_secret_'+'a'.repeat(30)}]])assert.throws(()=>validateCodeFiles(files as any));
});
