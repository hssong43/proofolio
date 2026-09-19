import { VerificationFlow } from "@/components/VerificationFlow";
import { DEFAULT_QUESTION_COUNT } from "@/lib/data";

type SearchParams = Promise<{ seconds?: string; questions?: string; demo?: string; fast?: string }>;

const intIn = (raw: string | undefined, min: number, max: number, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { seconds, questions, demo, fast } = await searchParams;
  return (
    <VerificationFlow
      totalSeconds={intIn(seconds, 10, 120, 40)}
      questionCount={intIn(questions, 1, 20, DEFAULT_QUESTION_COUNT)}
      demo={demo === "1"}
      fastAnalysis={fast === "1"}
    />
  );
}
