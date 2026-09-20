import { CandidateFlow } from '@/components/candidate/CandidateFlow';
export default async function TestEntryPage({searchParams}:{searchParams:Promise<{submission?:string}>}) {
  const {submission}=await searchParams;
  return <CandidateFlow resumeSubmissionId={submission}/>;
}
