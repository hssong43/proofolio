import { RecruitingDashboard } from '@/components/dashboard/RecruitingDashboard';
import { contestSettings } from '@/lib/server/contest';
import { notFound } from 'next/navigation';
export const dynamic='force-dynamic';
export default async function TestPage({params}:{params:Promise<{testId:string}>}) {
  if(contestSettings().enabled)notFound();
  const {testId}=await params;
  return <RecruitingDashboard testId={testId}/>;
}
