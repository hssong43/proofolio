import { NextResponse } from 'next/server';
import { sessionCookie, sessionUser } from '@/lib/server/session';
import { contestSettings } from '@/lib/server/contest';
import { sameOrigin } from '@/lib/server/runner';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
  if (!sameOrigin(request)) return json({ error: '허용되지 않는 요청이에요.' }, 403);
  const contest = contestSettings();
  if (!contest.enabled) return json({ error: '체험 경로가 아니에요.' }, 404);
  if (contest.closed) return json({ error: '대회 체험이 종료됐어요.' }, 410);
  // No Auth account, email, identity form or DB row on entry. The secret stays HttpOnly.
  const user = sessionUser(request, true)!;
  const response = json({ ready: true });
  response.cookies.set({ ...sessionCookie(request, user.token), maxAge: 86400,
    secure: new URL(request.url).protocol === 'https:' || process.env.PROOFOLIO_APP_URL?.startsWith('https://') === true });
  return response;
}
