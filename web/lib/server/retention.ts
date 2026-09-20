import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dbRequest, rpc } from './database.ts';
import { assetPrefix, PRIVATE_BUCKET, storageClient } from './assets.ts';
import { ROOT, isActiveRun } from './runner.ts';
import { contestSettings } from './contest.ts';

let running=false;
export async function cleanupExpiredRuns() {
  if(running)return;
  running=true;
  try {
    const contest=contestSettings();
    if(contest.enabled&&contest.closed)await rpc('proofolio_expire_guests',{});
    const [runs,examples]=await Promise.all([
      dbRequest(`/rest/v1/proofolio_runs?expires_at=lte.${encodeURIComponent(new Date().toISOString())}&select=id,user_id,state,started_at&order=expires_at.asc&limit=20`),
      dbRequest('/rest/v1/proofolio_examples?select=source_run_id')]);
    const protectedIds=new Set(examples.map((r:{source_run_id:string})=>r.source_run_id));
    const bucket=storageClient().storage.from(PRIVATE_BUCKET);
    for(const run of runs){
      if(protectedIds.has(run.id))continue;
      // A signed upload URL stays valid for two hours (issued within five minutes of admission).
      // Even a failed/deleted run must stay tracked until it can no longer recreate a removed object.
      if(isActiveRun(run.id)||Date.parse(run.started_at)>Date.now()-3*60*60*1000)continue;
      const prefix=assetPrefix(run.user_id,run.id);
      const {data,error}=await bucket.list(prefix.slice(0,-1),{limit:1000});
      if(error||!data||data.length===1000||data.some(f=>!f.id||f.name.includes('/')))throw new Error('만료 파일 목록을 확인하지 못했어요.');
      if(data.length){const removed=await bucket.remove(data.map(f=>prefix+f.name));if(removed.error)throw new Error('만료 파일 삭제 실패');}
      // Keep the DB row as a retry marker until BOTH storage and this run's local backup are gone.
      // Never remove benchmark originals or a workspace root.
      await rm(join(ROOT,'output','web','runs',run.id),{recursive:true,force:true});
      await rpc('proofolio_purge_run',{p_run_id:run.id});
    }
    await rpc('proofolio_purge_recruiting',{});
    if(contest.enabled)await rpc('proofolio_purge_guest_profiles',{});
  } finally { running=false; }
}
