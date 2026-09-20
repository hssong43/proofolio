import { RecruitingDashboard } from '@/components/dashboard/RecruitingDashboard';
export default async function TestPage({params}:{params:Promise<{testId:string}>}) {
  const {testId}=await params;
  return <RecruitingDashboard testId={testId}/>;
}
