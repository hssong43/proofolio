import { AccountApp } from "@/components/AccountApp";
import { DEFAULT_QUESTION_COUNT } from "@/lib/data";
import { safeReturnPath } from '@/lib/params';

type SearchParams = Promise<{ seconds?: string; questions?: string; demo?: string; fast?: string; run?: string; recovery?: string; auth_error?: string; login?: string; next?: string }>;

const intIn = (raw: string | undefined, min: number, max: number, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { seconds, questions, demo, fast, run, recovery, auth_error, login, next } = await searchParams;
  return (
    <AccountApp
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
