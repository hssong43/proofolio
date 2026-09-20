import { recruitingRoute } from '@/lib/server/recruiting-route';
import { rescoreSubmission } from '@/lib/server/recruiting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ testId: string; submissionId: string }> }) {
  const { testId, submissionId } = await context.params;
  return recruitingRoute(request, userId => rescoreSubmission(testId, submissionId, userId));
}
