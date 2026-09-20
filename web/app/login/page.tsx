import { redirect } from 'next/navigation';
import { safeReturnPath } from '@/lib/params';
import { contestSettings } from '@/lib/server/contest';
export const dynamic='force-dynamic';
export default async function LoginPage({searchParams}:{searchParams:Promise<{next?:string}>}) {
  if(contestSettings().enabled)redirect('/');
  const {next}=await searchParams;
  const destination=safeReturnPath(next)??'/dashboard';
  redirect('/?login=1&next='+encodeURIComponent(destination));
}
