import { RecruitingDashboard } from '@/components/dashboard/RecruitingDashboard';
import { DemoDashboard } from '@/components/dashboard/DemoDashboard';
import { contestSettings } from '@/lib/server/contest';
import { notFound } from 'next/navigation';
export const dynamic='force-dynamic';
export default function DashboardPage(){
  const contest=contestSettings();
  if(contest.enabled&&contest.closed)notFound();
  return contest.enabled?<DemoDashboard/>:<RecruitingDashboard/>;
}
