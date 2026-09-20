import { AccountApp } from "@/components/AccountApp";
import { DEFAULT_QUESTION_COUNT } from "@/lib/data";
import { safeReturnPath } from '@/lib/params';
import { contestSettings } from '@/lib/server/contest';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ seconds?: string; questions?: string; demo?: string; fast?: string; run?: string; recovery?: string; auth_error?: string; login?: string; next?: string }>;

const intIn = (raw: string | undefined, min: number, max: number, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { seconds, questions, demo, fast, run, recovery, auth_error, login, next } = await searchParams;
  const contest=contestSettings();
  if(contest.enabled&&contest.closed)return <main className="app-main"><section className="screen"><h1 className="screen-title">프리뷰가 종료됐어요</h1><p>proofolio를 체험해주셔서 감사합니다. 제출 자료는 보관 정책에 따라 정리해요.</p></section></main>;
  return (
    <AccountApp
      contest={contest.enabled}
      totalSeconds={intIn(seconds, 10, 120, 40)}
      questionCount={intIn(questions, 6, DEFAULT_QUESTION_COUNT, DEFAULT_QUESTION_COUNT)}
      demo={demo === "1"}
      fastAnalysis={fast === "1"}
      resumeRunId={run && /^[a-f0-9-]{36}$/.test(run) ? run : undefined}
      recovery={recovery === '1'} authError={auth_error === '1'}
      loginRequested={login === '1'} returnTo={safeReturnPath(next)}
    />
  );
}
