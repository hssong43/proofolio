import { submissionDetail } from '@/lib/server/recruiting';
import { recruitingRoute } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request: Request,{params}:{params:Promise<{testId:string;submissionId:string}>}) {
  const {testId,submissionId}=await params;
  return recruitingRoute(request,userId=>submissionDetail(testId,submissionId,userId));
}
