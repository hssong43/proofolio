import { redirect } from 'next/navigation';
import { safeReturnPath } from '@/lib/params';
export default async function LoginPage({searchParams}:{searchParams:Promise<{next?:string}>}) {
  const {next}=await searchParams;
  const destination=safeReturnPath(next)??'/dashboard';
  redirect('/?login=1&next='+encodeURIComponent(destination));
}
