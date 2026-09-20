import { CandidateFlow } from "@/components/candidate/CandidateFlow";

type SearchParams = Promise<{ fast?: string }>;

export default async function TestEntryPage({ searchParams }: { searchParams: SearchParams }) {
  const { fast } = await searchParams;
  return <CandidateFlow fast={fast === "1"} />;
}
