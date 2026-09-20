import { sessionUser } from './session.ts';
import { contestSettings } from './contest.ts';
import { AnswerError } from './runner.ts';

/** Only analysis ownership is anonymous. Recruiting/Auth never use this helper. */
export async function runUser(request: Request) {
  const contest = contestSettings();
  if (contest.enabled) {
    if (contest.closed) throw new AnswerError('대회 체험이 종료됐어요.', 410);
    const session = sessionUser(request);
    if (!session) throw new AnswerError('체험 세션이 없거나 만료됐어요. 새로고침해주세요.', 401);
    return { id: session.id, member: false as const, guestExpiresAt: contest.expiresAt };
  }
  const { requireUser } = await import('./auth.ts');
  const user = await requireUser();
  return { id: user.id, authId: user.authId, member: true as const, guestExpiresAt: undefined };
}
