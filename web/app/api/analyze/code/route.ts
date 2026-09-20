import { NextResponse } from 'next/server';
import { runUser } from '@/lib/server/access';
import { ensureMember } from '@/lib/server/database';
import { AnswerError, ROOT, sameOrigin, startRun } from '@/lib/server/runner';
import { githubCode } from '../../../../../src/coding.ts';
import { executionBudget } from '../../../../../src/env.ts';
import { authorizeCandidateAnalysis } from '@/lib/server/recruiting';
export const runtime='nodejs';
export async function POST(request:Request){
  if(!sameOrigin(request))return NextResponse.json({error:'같은 사이트에서만 요청할 수 있어요.'},{status:403});
  try {
    const user=await runUser(request);
    executionBudget(ROOT,process.env); // No GitHub fetch if paid execution is disabled.
    const text=await request.text();if(text.length>2048)throw new AnswerError('요청이 너무 커요.',413);
    const body=JSON.parse(text),count=body?.maxQuestions??10;
    if(typeof body?.url!=='string'||!Number.isInteger(count)||count<6||count>10)throw new AnswerError('저장소 주소와 질문 수 6~10개를 확인해주세요.',400);
    if(user.member)await ensureMember(user.id,user.authId);
    if(body.submissionId!==undefined){
      if(!user.member)throw new AnswerError('프리뷰에서는 채용 응시 정보를 받지 않아요.',403);
      await authorizeCandidateAnalysis(body.submissionId,user.id,'coding',count);
    }
    const code=await githubCode(body.url);
    const status=await startRun({bytes:Buffer.from(JSON.stringify(code)),fileName:code.name,track:'coding',maxQuestions:count,userId:user.id,member:user.member,guestExpiresAt:user.guestExpiresAt});
    return NextResponse.json({runId:status.runId});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:'코드 분석을 시작하지 못했어요.'},{status:e instanceof AnswerError?e.status:400});}
}
