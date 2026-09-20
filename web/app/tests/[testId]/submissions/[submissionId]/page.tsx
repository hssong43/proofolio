import { RecruitingDashboard } from '@/components/dashboard/RecruitingDashboard';
import { contestSettings } from '@/lib/server/contest';
import { notFound } from 'next/navigation';
export const dynamic='force-dynamic';
export default async function SubmissionPage({params}:{params:Promise<{testId:string;submissionId:string}>}) {
  if(contestSettings().enabled)notFound();
  return <RecruitingDashboard {...await params}/>;
}
