export async function register() {
  if(process.env.NEXT_RUNTIME!=='nodejs')return;
  const {loadRuntimeEnv}=await import('../src/env.ts');
  const {ROOT}=await import('./lib/server/runner.ts');
  loadRuntimeEnv(ROOT);
  if(process.env.PROOFOLIO_STORAGE!=='supabase')return;
  const state=globalThis as typeof globalThis & {proofolioCleanupTimer?:ReturnType<typeof setInterval>};
  if(state.proofolioCleanupTimer)return;
  const {cleanupExpiredRuns}=await import('./lib/server/retention.ts');
  const clean=()=>void cleanupExpiredRuns().catch(()=>console.error('보관 기간 정리를 완료하지 못했습니다. 다음 주기에 재시도합니다.'));
  // ponytail: long-running single Node server; use a scheduled job before serverless deployment.
  state.proofolioCleanupTimer=setInterval(clean,24*60*60*1000);state.proofolioCleanupTimer.unref();clean();
}
