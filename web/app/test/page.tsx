import { CandidateFlow } from '@/components/candidate/CandidateFlow';
import { contestSettings } from '@/lib/server/contest';
import { notFound } from 'next/navigation';
export const dynamic='force-dynamic';
export default async function TestEntryPage({searchParams}:{searchParams:Promise<{submission?:string}>}) {
  if(contestSettings().enabled)notFound();
  const {submission}=await searchParams;
  return <CandidateFlow resumeSubmissionId={submission}/>;
}
