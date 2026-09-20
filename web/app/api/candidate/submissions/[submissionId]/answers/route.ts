import { completeSubmission } from '@/lib/server/recruiting';
import { recruitingRoute, recruitingBody } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request: Request,{params}:{params:Promise<{submissionId:string}>}) {
  const {submissionId}=await params;
  return recruitingRoute(request,async userId=>{
    await completeSubmission(submissionId,userId,await recruitingBody(request));
    return {ok:true,submissionId};
  });
}
