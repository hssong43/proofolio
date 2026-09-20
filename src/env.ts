import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';

// Only server-side runtime settings are loaded. Never import legacy Gemini/GCP credentials.
export function loadEnv(path:string,env:NodeJS.ProcessEnv=process.env) {
  if(!existsSync(path))return;
  for(const [i,line] of readFileSync(path,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
    const match=line.trim().match(/^(?:export\s+)?(OPENROUTER_API_KEY|OPENROUTER_MODEL|OPENROUTER_SKIM_MODEL|OPENROUTER_REVIEW_MODEL|OPENROUTER_QUESTION_MODEL|OPENROUTER_SCORING_MODEL|PROOFOLIO_MAX_COST_USD|PROOFOLIO_BUDGET_LEDGER|PROOFOLIO_EXECUTION|PROOFOLIO_STORAGE|PROOFOLIO_APP_URL|PROOFOLIO_CONTEST_MODE|PROOFOLIO_CONTEST_CLOSED|PROOFOLIO_CONTEST_ENDS_AT|SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*(.*)$/);if(!match)continue;
    const value=match[2];
    if(value.startsWith('"')&&!/^"[^"\r\n]*"\s*(?:#.*)?$/.test(value)
      ||value.startsWith("'")&&!/^'[^'\r\n]*'\s*(?:#.*)?$/.test(value)
      ||!/^['"]/.test(value)&&!/^\S*(?:\s+#.*)?$/.test(value))throw new Error(`.env ${i+1}행 형식 오류. 값을 출력하지 않습니다.`);
    const parsed=parseEnv(line);if(env[match[1]]===undefined)env[match[1]]=parsed[match[1]]??'';
  }
}
export function loadRuntimeEnv(root:string,env:NodeJS.ProcessEnv=process.env) {
  loadEnv(resolve(root,'.env'),env);
  loadEnv(resolve(root,'.env.openrouter'),env); // Existing private key file remains supported.
}
export function executionBudget(root:string,env:NodeJS.ProcessEnv,overrides:{limit?:string;ledger?:string}={}) {
  const limit=Number(overrides.limit??env.PROOFOLIO_MAX_COST_USD??'0');
  if(!Number.isFinite(limit)||limit<=0||limit>10)
    throw new Error('유료 분석에는 --max-cost-usd 또는 PROOFOLIO_MAX_COST_USD로 승인한 누적 한도(0 초과 10달러 이하)를 명시하세요.');
  const ledger=resolve(root,overrides.ledger??env.PROOFOLIO_BUDGET_LEDGER??'output/openrouter-budget.jsonl');
  if(['output/api-budget.jsonl','output/benchmark/api-budget.jsonl','output/gcp-opus-budget.jsonl','output/web/api-budget.jsonl'].some(p=>resolve(root,p)===ledger))
    throw new Error('기존 Gemini/GCP 원장은 읽기 전용 기록입니다. OpenRouter 전용 원장을 사용하세요.');
  return {limit,ledger};
}
