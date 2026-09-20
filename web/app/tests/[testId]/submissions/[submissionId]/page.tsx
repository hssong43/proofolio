import { RecruitingDashboard } from '@/components/dashboard/RecruitingDashboard';
export default async function SubmissionPage({params}:{params:Promise<{testId:string;submissionId:string}>}) {
  return <RecruitingDashboard {...await params}/>;
}
