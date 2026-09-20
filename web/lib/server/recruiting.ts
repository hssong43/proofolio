import { randomInt } from 'node:crypto';
import { dbRequest, rpc, databaseRun, databaseAnswers, publicStatus } from './database.ts';
import { AnswerError } from './runner.ts';
import { CODE_ALPHABET, CODE_LENGTH, isValidCode } from '../codes.ts';
import { validateCandidate } from '../candidate.ts';
import { validatePeriod, testStatus } from '../period.ts';
import { ROLES } from '../data.ts';
import type { Candidate, PublicTest, Submission, SubmissionDetail, TestRecord, TestSummary } from '../types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new AnswerError('잘못된 항목 ID예요.', 400);
}
function validMember(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new AnswerError('로그인이 필요해요.', 401);
}
type TestRow = { id: string; code: string; title: string; role: TestRecord['role']; starts_at: string; ends_at: string;
  created_at: string; total_seconds: number; question_count: number; submission_count: number; completed_count: number };
type SubmissionRow = { id: string; test_id: string; candidate_name: string; birth_date: string; phone: string;
  joined_at: string; completed_at: string | null; run_id: string | null };
const toTest = (r: TestRow): TestRecord => ({id:r.id,code:r.code,title:r.title,role:r.role,startsAt:r.starts_at,
  endsAt:r.ends_at,createdAt:r.created_at,totalSeconds:r.total_seconds,questionCount:r.question_count});
const toSummary = (r: TestRow): TestSummary => ({...toTest(r),status:testStatus(toTest(r)),
  submissionCount:Number(r.submission_count),completedCount:Number(r.completed_count)});
const toSubmission = (r: SubmissionRow): Submission => ({id:r.id,testId:r.test_id,
  candidate:{name:r.candidate_name,birthDate:r.birth_date,phone:r.phone},joinedAt:r.joined_at,
  completedAt:r.completed_at,state:r.completed_at?'completed':'joined',runId:r.run_id});
const active = () => 'expires_at=gt.' + encodeURIComponent(new Date().toISOString());
export function publicTest(t: TestRecord): PublicTest {
  return {testId:t.id,title:t.title,role:t.role,roleLabel:ROLES.find(r=>r.id===t.role)!.label,
    startsAt:t.startsAt,endsAt:t.endsAt,totalSeconds:t.totalSeconds,questionCount:t.questionCount};
}
export function validateNewTest(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length>80) throw new AnswerError('제목은 1~80자로 입력해주세요.',400);
  const role = ROLES.find(r=>r.id===body.role);
  if (!role) throw new AnswerError('직무를 선택해주세요.',400);
  const period = validatePeriod(body.startsAt,body.endsAt);
  if (!period.ok) throw new AnswerError(period.error,400);
  if (Date.parse(period.endsAt)<=Date.now()) throw new AnswerError('종료 시각은 현재보다 뒤여야 해요.',400);
  const count = body.questionCount ?? 10;
  if (typeof count!=='number' || !Number.isInteger(count) || count<6 || count>10)
    throw new AnswerError('질문 수는 6~10개예요.',400);
  return {title,role:role.id,starts_at:period.startsAt,ends_at:period.endsAt,question_count:count};
}
export async function createTest(userId: string, body: Record<string, unknown>): Promise<TestRecord> {
  validMember(userId);
  const input=validateNewTest(body);
  const code=Array.from({length:CODE_LENGTH},()=>CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const rows=await dbRequest('/rest/v1/proofolio_tests',{method:'POST',headers:{Prefer:'return=representation'},
    body:JSON.stringify({...input,owner_id:userId,code})});
  if (!rows?.[0]) throw new AnswerError('테스트 저장 응답을 확인하지 못했어요.',503);
  return toTest(rows[0]); // A code collision fails visibly; no duplicate creation retry.
}
export async function listTests(userId: string): Promise<TestSummary[]> {
  validMember(userId);
  const rows: TestRow[]=await dbRequest('/rest/v1/proofolio_test_summaries?owner_id=eq.'+userId+'&select=*&order=created_at.desc&limit=100');
  return rows.map(toSummary);
}
export async function ownedTest(id: string, userId: string): Promise<TestSummary> {
  validId(id);validMember(userId);
  const rows=await dbRequest('/rest/v1/proofolio_test_summaries?id=eq.'+id+'&owner_id=eq.'+userId+'&select=*&limit=1');
  if(!rows?.[0])throw new AnswerError('테스트를 찾을 수 없어요.',404);
  return toSummary(rows[0]);
}
export async function listSubmissions(testId: string, userId: string) {
  const test=await ownedTest(testId,userId);
  // ponytail: at most 500 applicants per view; add cursor pagination before larger hiring campaigns.
  const rows: SubmissionRow[]=await dbRequest('/rest/v1/proofolio_submissions?test_id=eq.'+testId+'&'+active()+'&select=*&order=joined_at.desc&limit=500');
  return {test,submissions:rows.map(toSubmission)};
}
export async function submissionDetail(testId: string, submissionId: string, ownerId: string): Promise<SubmissionDetail> {
  validId(submissionId);
  const test=await ownedTest(testId,ownerId);
  const rows=await dbRequest('/rest/v1/proofolio_submissions?id=eq.'+submissionId+'&test_id=eq.'+testId+'&'+active()+'&select=*&limit=1');
  if(!rows?.[0])throw new AnswerError('응시 결과를 찾을 수 없어요.',404);
  const submission=toSubmission(rows[0]);
  // Read canonical answers; never accept snapshots or questions from a browser.
  const stored=submission.runId ? await databaseRun(submission.runId) : null;
  const run=stored && stored.userId===rows[0].user_id ? publicStatus(stored) : null;
  if(run) {
    run.answers=await databaseAnswers(run.runId);
    // A recruiting consent shares cards/answers, not PDFs or private source-file links.
    if(run.result)run.result={...run.result,sourceAssets:undefined};
  }
  return {test,submission,run};
}
export async function resolveOpenTest(code: unknown): Promise<PublicTest> {
  if(typeof code!=='string'||!isValidCode(code))throw new AnswerError('참여 코드를 확인해주세요.',400);
  const rows=await dbRequest('/rest/v1/proofolio_tests?code=eq.'+code+'&select=*&limit=1');
  if(!rows?.[0]||testStatus(toTest(rows[0]))!=='open')throw new AnswerError('코드가 없거나 응시 기간이 아니에요.',404);
  return publicTest(toTest(rows[0]));
}
export async function candidateSubmission(id: string, userId: string) {
  validId(id);validMember(userId);
  const rows=await dbRequest('/rest/v1/proofolio_submissions?id=eq.'+id+'&user_id=eq.'+userId+'&'+active()+'&select=*&limit=1');
  if(!rows?.[0])throw new AnswerError('응시 정보를 찾을 수 없어요.',404);
  const submission=toSubmission(rows[0]);
  const tests=await dbRequest('/rest/v1/proofolio_tests?id=eq.'+submission.testId+'&select=*&limit=1');
  if(!tests?.[0])throw new AnswerError('테스트를 찾을 수 없어요.',404);
  return {submission,test:publicTest(toTest(tests[0]))};
}
export async function authorizeCandidateAnalysis(id: unknown, userId: string, track: string, questionCount: number) {
  validId(id);
  const {submission,test}=await candidateSubmission(id,userId);
  if(submission.runId||submission.completedAt)throw new AnswerError('이미 연결된 분석이 있어요. 기존 응시를 이어가세요.',409);
  if(testStatus(test)!=='open')throw new AnswerError('응시 기간이 아니에요.',409);
  if(ROLES.find(r=>r.id===test.role)?.track!==track||test.questionCount!==questionCount)
    throw new AnswerError('테스트의 직무와 질문 수를 바꿀 수 없어요.',400);
}
export async function joinTest(userId: string, body: Record<string, unknown>) {
  validMember(userId);
  await resolveOpenTest(body.code);
  const info=validateCandidate(body);
  if(!info.ok)throw new AnswerError(info.error,400);
  if(body.consent!==true)throw new AnswerError('응시 정보와 답변 공유에 동의해주세요.',400);
  const id=await rpc('proofolio_join_test',{p_code:body.code,p_user_id:userId,p_candidate:info.candidate,p_consent:true});
  validId(id);
  return candidateSubmission(id,userId);
}
export function canonicalRunId(body: Record<string, unknown>): string {
  if(Object.keys(body).length!==1||!('runId' in body))throw new AnswerError('저장된 실행 ID만 보낼 수 있어요.',400);
  validId(body.runId);return body.runId;
}
export async function linkSubmission(id: string, userId: string, body: Record<string, unknown>) {
  validId(id);validMember(userId);const runId=canonicalRunId(body);
  const linked=await rpc('proofolio_link_submission_run',{p_submission_id:id,p_user_id:userId,p_run_id:runId});
  if(linked!==runId)throw new AnswerError('실행 연결 응답을 확인하지 못했어요. 연결만 재시도해주세요.',503);
}
export async function completeSubmission(id: string, userId: string, body: Record<string, unknown>) {
  validId(id);validMember(userId);const runId=canonicalRunId(body);
  const saved=await rpc('proofolio_complete_submission',{p_submission_id:id,p_user_id:userId,p_run_id:runId});
  if(saved!==id)throw new AnswerError('제출 완료 응답을 확인하지 못했어요. 제출 확인만 재시도해주세요.',503);
}
export async function deleteTest(id: string, userId: string) {
  await ownedTest(id,userId);
  if(await rpc('proofolio_delete_test',{p_test_id:id,p_owner_id:userId})!==id)throw new AnswerError('삭제 확인에 실패했어요.',503);
}
