import { joinTest } from '@/lib/server/recruiting';
import { recruitingRoute, recruitingBody } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=(request: Request)=>recruitingRoute(request,async userId=>joinTest(userId,await recruitingBody(request)));
