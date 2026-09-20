import { redirect } from 'next/navigation';
import { contestSettings } from '@/lib/server/contest';
export const dynamic='force-dynamic';
export default function DemoPage(){redirect(contestSettings().enabled?'/':'/?demo=1');}
