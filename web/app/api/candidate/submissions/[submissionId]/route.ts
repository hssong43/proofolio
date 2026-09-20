import { candidateSubmission, linkSubmission } from '@/lib/server/recruiting';
import { recruitingRoute, recruitingBody } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{submissionId:string}>};
export async function GET(request: Request,{params}:Context) {
  const {submissionId}=await params;
  return recruitingRoute(request,userId=>candidateSubmission(submissionId,userId));
}
export async function POST(request: Request,{params}:Context) {
  const {submissionId}=await params;
  return recruitingRoute(request,async userId=>{
    await linkSubmission(submissionId,userId,await recruitingBody(request));
    return {ok:true};
  });
}
