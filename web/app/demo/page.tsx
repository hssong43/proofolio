import { VerificationFlow } from "@/components/VerificationFlow";
import { DEFAULT_QUESTION_COUNT } from "@/lib/data";
import { intIn } from "@/lib/params";

type SearchParams = Promise<{ seconds?: string; questions?: string; demo?: string; fast?: string }>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { seconds, questions, demo, fast } = await searchParams;
  return (
    <VerificationFlow
      totalSeconds={intIn(seconds, 10, 120, 40)}
      questionCount={intIn(questions, 1, DEFAULT_QUESTION_COUNT, DEFAULT_QUESTION_COUNT)}
      demo={demo === "1"}
      fastAnalysis={fast === "1"}
    />
  );
}
