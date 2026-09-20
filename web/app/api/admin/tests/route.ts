import { createTest, listTests } from '@/lib/server/recruiting';
import { recruitingRoute, recruitingBody } from '@/lib/server/recruiting-route';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=(request: Request)=>recruitingRoute(request,async userId=>({tests:await listTests(userId)}));
export const POST=(request: Request)=>recruitingRoute(request,async userId=>({test:await createTest(userId,await recruitingBody(request))}));
