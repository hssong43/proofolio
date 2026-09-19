import { VerificationFlow } from "@/components/VerificationFlow";

type SearchParams = Promise<{ seconds?: string; fast?: string }>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { seconds, fast } = await searchParams;
  const parsed = Number(seconds);
  const totalSeconds = Number.isInteger(parsed) && parsed >= 10 && parsed <= 120 ? parsed : 40;
  return <VerificationFlow totalSeconds={totalSeconds} fastAnalysis={fast === "1"} />;
}
