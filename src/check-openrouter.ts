// Read-only key, models, exact endpoint capabilities/prices and ZDR intersection. No generation or ledger mutation.
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {loadEnv} from './env.ts';
import {freshMetrics} from './llm.ts';
import {openRouterSession} from './openrouter.ts';

export async function checkOpenRouter() {
  loadEnv(fileURLToPath(new URL('../.env',import.meta.url)));
  loadEnv(fileURLToPath(new URL('../.env.openrouter',import.meta.url)));
  return openRouterSession(process.env.OPENROUTER_API_KEY??'',freshMetrics(),undefined).checkAccess();
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{console.log(JSON.stringify(await checkOpenRouter(),null,2));}
  catch(e){console.error(e instanceof Error?e.message:'OpenRouter 연결 확인 실패.');process.exitCode=1;}
}
