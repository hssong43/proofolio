import { resolveOpenTest } from '@/lib/server/recruiting';
import { recruitingRoute, recruitingBody } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=(request: Request)=>recruitingRoute(request,async()=>resolveOpenTest((await recruitingBody(request)).code));
