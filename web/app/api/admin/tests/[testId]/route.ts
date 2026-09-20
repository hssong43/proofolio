import { listSubmissions, deleteTest } from '@/lib/server/recruiting';
import { recruitingRoute } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{testId:string}>};
export async function GET(request: Request,{params}:Context) {
  const {testId}=await params;
  return recruitingRoute(request,userId=>listSubmissions(testId,userId));
}
export async function DELETE(request: Request,{params}:Context) {
  const {testId}=await params;
  return recruitingRoute(request,async userId=>{await deleteTest(testId,userId);return {ok:true};});
}
