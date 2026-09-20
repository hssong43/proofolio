import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dbRequest, rpc } from './database.ts';
import { assetPrefix, PRIVATE_BUCKET, storageClient } from './assets.ts';
import { ROOT } from './runner.ts';

let running=false;
export async function cleanupExpiredRuns() {
  if(running)return;
  running=true;
  try {
    const [runs,examples]=await Promise.all([
      dbRequest(`/rest/v1/proofolio_runs?expires_at=lte.${encodeURIComponent(new Date().toISOString())}&select=id,user_id&order=expires_at.asc&limit=20`),
      dbRequest('/rest/v1/proofolio_examples?select=source_run_id')]);
    const protectedIds=new Set(examples.map((r:{source_run_id:string})=>r.source_run_id));
    const bucket=storageClient().storage.from(PRIVATE_BUCKET);
    for(const run of runs){
      if(protectedIds.has(run.id))continue;
      const prefix=assetPrefix(run.user_id,run.id);
      const {data,error}=await bucket.list(prefix.slice(0,-1),{limit:1000});
      if(error||!data||data.length===1000||data.some(f=>!f.id||f.name.includes('/')))throw new Error('만료 파일 목록을 확인하지 못했어요.');
      if(data.length){const removed=await bucket.remove(data.map(f=>prefix+f.name));if(removed.error)throw new Error('만료 파일 삭제 실패');}
      await rpc('proofolio_purge_run',{p_run_id:run.id});
      // Only this expired run's local backup, never benchmark originals or a workspace root.
      await rm(join(ROOT,'output','web','runs',run.id),{recursive:true,force:true});
    }
  } finally { running=false; }
}
