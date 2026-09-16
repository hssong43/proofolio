import {createHash, randomUUID} from 'node:crypto';
import {appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import * as z from 'zod';
import {MAX_PDF_BYTES} from './pdf.ts';
import {responseSchema} from './schema.ts';
import {SYSTEM} from './prompts.ts';

export const BASE_URL='https://generativelanguage.googleapis.com';
const MAX_REQUEST_BYTES=19*1024*1024;
export const MAX_OUTPUT_TOKENS=16384;
export class SchemaValidationError extends Error {}
export class BudgetError extends Error {}
export type Usage = {promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number;
  cachedContentTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; [key:string]:unknown};
export type Metrics = {model_calls:number; uploads:number; uploaded_bytes:number; file_reuses:number;
  cleanup_failures:number; usage:Array<Record<string,unknown>>; first_evidence_ms:number|null;
  total_ms?:number; stages:Array<{stage:string; elapsed_ms:number; attempt:number}>; estimated_cost_usd:number;
  total_tokens:number;input_tokens:number;output_tokens:number;thinking_tokens:number;cached_tokens:number};
export const freshMetrics = ():Metrics => ({model_calls:0,uploads:0,uploaded_bytes:0,file_reuses:0,cleanup_failures:0,
  usage:[],first_evidence_ms:null,stages:[],estimated_cost_usd:0,total_tokens:0,input_tokens:0,output_tokens:0,thinking_tokens:0,cached_tokens:0});
export function validateConfig(apiKey: unknown, model: unknown): asserts apiKey is string {
  if (typeof apiKey!=='string' || !/^[!-~]+$/.test(apiKey)) throw new Error('GEMINI_API_KEY를 환경변수로 설정하세요.');
  if (typeof model!=='string' || !/^gemini-[A-Za-z0-9._-]+$/.test(model)) throw new Error('유효한 Gemini 모델 ID가 필요합니다.');
}
export function priceFor(model:string, now=new Date()) {
  // Verified standard API rates, no Batch/priority/search/tools or explicit cache storage.
  // https://ai.google.dev/gemini-api/docs/pricing (2026-09-16)
  if(!['gemini-3.8-flash','gemini-3.7-flash'].includes(model) || now.toISOString().slice(0,10)>'2026-12-31')
    throw new BudgetError('모델 가격표를 확인할 수 없거나 만료되었습니다. 호출을 중단합니다.');
  return {input:0.75,output:3.75,cached:0.075};
}
const count = (n:unknown):n is number => typeof n==='number' && Number.isSafeInteger(n) && n>=0;
export function usageCost(model:string, raw:unknown) {
  const u=raw as Partial<Usage>|null;
  if(!u || !count(u.promptTokenCount)||!count(u.candidatesTokenCount)||!count(u.totalTokenCount)
    || (u.cachedContentTokenCount!==undefined&&!count(u.cachedContentTokenCount))
    || (u.thoughtsTokenCount!==undefined&&!count(u.thoughtsTokenCount))) throw new BudgetError('토큰 사용량을 확인할 수 없습니다.');
  const cached=u.cachedContentTokenCount??0, thoughts=u.thoughtsTokenCount??0;
  if(cached>u.promptTokenCount || u.totalTokenCount<u.promptTokenCount+u.candidatesTokenCount)
    throw new BudgetError('토큰 사용량이 일관되지 않습니다.');
  const rates=priceFor(model);
  // total minus input captures thinking even when older responses omit thoughtsTokenCount.
  const output=Math.max(u.candidatesTokenCount+thoughts,u.totalTokenCount-u.promptTokenCount);
  return ((u.promptTokenCount-cached)*rates.input+cached*rates.cached+output*rates.output)/1e6;
}
type LedgerEvent = {type:'header';version:1;limit_usd:number}|{type:'reserve';id:string;usd:number;model:string;at:string}
  |{type:'settle';id:string;usd:number}|{type:'blocked';reason:string}
  |{type:'ceiling';usd:number;baseline_usd:number;limit_krw:number;krw_per_usd:number};
export class Budget {
  readonly limit:number;
  readonly path:string;
  spent=0;
  readonly pending=new Map<string,number>();
  blocked=false;
  private lock:string;
  private closed=false;
  private ceiling:number;
  private window:Extract<LedgerEvent,{type:'ceiling'}>|undefined;
  constructor(path:string,limit=10) {
    if(!Number.isFinite(limit)||limit<=0||limit>10) throw new BudgetError('이 작업 예산은 0 초과 10달러 이하입니다.');
    this.path=path; this.limit=limit; this.ceiling=limit; this.lock=path+'.lock';
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const fd=openSync(this.lock,'wx',0o600); closeSync(fd);
    try {
      if(!existsSync(path)) writeFileSync(path,JSON.stringify({type:'header',version:1,limit_usd:limit})+'\n',{flag:'wx',mode:0o600});
      const rows=readFileSync(path,'utf8').trim().split('\n').map(s=>JSON.parse(s)) as LedgerEvent[];
      const header=rows.shift();
      if(header?.type!=='header'||header.version!==1||header.limit_usd!==limit) throw new BudgetError('예산 원장 형식 또는 한도가 다릅니다.');
      for(const row of rows) this.apply(row);
      if(this.pending.size)this.block('unsettled_previous_process');
      if(this.spent+this.reserved>this.ceiling+1e-9) this.blocked=true;
    } catch(e) { unlinkSync(this.lock); throw e; }
  }
  get reserved(){return [...this.pending.values()].reduce((a,b)=>a+b,0);}
  get remaining(){return Math.max(0,this.ceiling-this.spent-this.reserved);}
  capAdditionalKrw(limit:number,krwPerUsd:number) {
    if(!Number.isFinite(limit)||limit<=0||!Number.isFinite(krwPerUsd)||krwPerUsd<=0||this.closed||this.blocked||this.pending.size)
      throw new BudgetError('안전한 추가 예산 창을 만들 수 없습니다.');
    if(this.window){if(this.window.limit_krw!==limit||this.window.krw_per_usd!==krwPerUsd)throw new BudgetError('기존 추가 예산 창과 설정이 다릅니다.');return;}
    this.append({type:'ceiling',usd:Math.min(this.limit,this.spent+limit/krwPerUsd),baseline_usd:this.spent,limit_krw:limit,krw_per_usd:krwPerUsd});
  }
  private apply(row:LedgerEvent) {
    if(row.type==='blocked'){this.blocked=true;return;}
    if(row.type==='ceiling'){
      if(this.window||!Number.isFinite(row.usd)||row.usd<this.spent||row.usd>this.limit||row.baseline_usd!==this.spent||
        !Number.isFinite(row.limit_krw)||row.limit_krw<=0||!Number.isFinite(row.krw_per_usd)||row.krw_per_usd<=0||
        row.usd!==Math.min(this.limit,row.baseline_usd+row.limit_krw/row.krw_per_usd))throw new BudgetError('추가 예산 창 오류.');
      this.window=row;this.ceiling=row.usd;return;
    }
    if(row.type==='header'||!Number.isFinite(row.usd)||row.usd<0) throw new BudgetError('예산 원장 오류.');
    if(row.type==='reserve') {
      if(this.pending.has(row.id)) throw new BudgetError('중복 예산 예약.');
      this.pending.set(row.id,row.usd);
    } else {
      if(!this.pending.has(row.id)) throw new BudgetError('예약 없는 비용 정산.');
      this.pending.delete(row.id);this.spent+=row.usd;
    }
  }
  private append(row:LedgerEvent){appendFileSync(this.path,JSON.stringify(row)+'\n',{mode:0o600,flush:true});this.apply(row);}
  reserve(model:string,input:number,maxOutput=MAX_OUTPUT_TOKENS) {
    if(this.closed||this.blocked) throw new BudgetError('비용 미확인 또는 종료된 예산 원장입니다. 신규 호출을 중단합니다.');
    if(!count(input)||!count(maxOutput)||maxOutput<1) throw new BudgetError('입력/최대 출력 토큰을 확인할 수 없습니다.');
    const rates=priceFor(model), usd=(input*rates.input+maxOutput*rates.output)/1e6;
    if(usd>this.remaining+1e-9) throw new BudgetError('누적/추가 예산의 남은 금액이 부족합니다.');
    const id=randomUUID();this.append({type:'reserve',id,usd,model,at:new Date().toISOString()});return id;
  }
  settle(id:string,model:string,usage:unknown) {
    let usd:number;
    try {usd=usageCost(model,usage);}catch(e){this.block('usage_unavailable');throw e;}
    const reserved=this.pending.get(id);
    if(reserved===undefined) throw new BudgetError('정산 예약이 없습니다.');
    this.append({type:'settle',id,usd});
    if(usd>reserved+1e-9||this.spent+this.reserved>this.ceiling+1e-9){this.block('reservation_exceeded');throw new BudgetError('예상 비용 상한 초과. 신규 호출을 중단합니다.');}
    return usd;
  }
  block(reason:string){if(!this.blocked)this.append({type:'blocked',reason});}
  snapshot(){return {limit_usd:this.limit,spent_usd:this.spent,reserved_usd:this.reserved,remaining_usd:this.remaining,blocked:this.blocked,
    ...(this.window?{spend_window:this.window,additional_estimated_krw:(this.spent-this.window.baseline_usd)*this.window.krw_per_usd}: {})};}
  close(){if(!this.closed){unlinkSync(this.lock);this.closed=true;}}
}

export type ModelRequest = {kind:string;schema:z.ZodType;prompt:string;model:string;pdf?:Uint8Array;pdf_uri?:string;
  images?:Array<[string,Uint8Array]>;maxOutputTokens?:number;thinkingLevel?:'LOW'|'MEDIUM'|'HIGH'};
export type Generate = (request:ModelRequest)=>Promise<unknown>;
export async function requestJson(url:string,init:RequestInit,apiKey:string,fetcher:typeof fetch=fetch):Promise<[Record<string,any>,Headers]> {
  let response:Response;
  try {response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(120_000)});}
  catch {throw new Error('Gemini 연결 실패 또는 시간 초과. 자동 재시도하지 않았습니다.');}
  const chunks:Uint8Array[]=[];let size=0;
  if(response.body) for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024){throw new Error('Gemini 응답 크기 초과.');}chunks.push(chunk);}
  let value:unknown;
  try {value=size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch {throw new Error(`Gemini HTTP ${response.status}: 유효하지 않은 JSON.`);}
  if(!response.ok){const message=(value as any)?.error?.message; const detail=typeof message==='string'?message.replaceAll(apiKey,'[REDACTED]').slice(0,800):'인증, 모델 접근, 할당량을 확인하세요.';
    throw new Error(`Gemini HTTP ${response.status}: ${detail}`);}
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('Gemini 응답 형식 오류.');
  return [value as Record<string,any>,response.headers];
}
export function buildPayload(request:ModelRequest) {
  if(request.pdf && request.pdf_uri) throw new Error('PDF 바이트와 URI 중 하나만 전달하세요.');
  const parts:Array<Record<string,unknown>>=[];
  if(request.pdf){if(!request.pdf.length||request.pdf.length>12*1024*1024)throw new Error('인라인 PDF는 12 MiB 이하입니다.');
    parts.push({inlineData:{mimeType:'application/pdf',data:Buffer.from(request.pdf).toString('base64')}});}
  if(request.pdf_uri){if(!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+$/.test(request.pdf_uri))throw new Error('신뢰할 수 없는 PDF 파일 URI.');
    parts.push({fileData:{mimeType:'application/pdf',fileUri:request.pdf_uri}});}
  for(const [label,png] of request.images??[]){if(png.length>6*1024*1024||!Buffer.from(png.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('이미지는 6 MiB 이하 PNG여야 합니다.');
    parts.push({text:label},{inlineData:{mimeType:'image/png',data:Buffer.from(png).toString('base64')}});}
  if(!request.prompt.trim())throw new Error('분석 지시가 필요합니다.');parts.push({text:request.prompt});
  const payload={systemInstruction:{parts:[{text:SYSTEM}]},contents:[{role:'user',parts}],generationConfig:{
    responseMimeType:'application/json',responseJsonSchema:responseSchema(request.schema),maxOutputTokens:request.maxOutputTokens??MAX_OUTPUT_TOKENS,
    ...(request.thinkingLevel?{thinkingConfig:{thinkingLevel:request.thinkingLevel}}:{})}};
  if(Buffer.byteLength(JSON.stringify(payload))>MAX_REQUEST_BYTES)throw new Error('요청이 19 MiB를 초과했습니다.');
  return payload;
}
export function parseModelResponse(result:Record<string,any>,schema:z.ZodType,apiKey:string):unknown {
  if(!Array.isArray(result.candidates)||result.candidates[0]?.finishReason!=='STOP'){
    const reason=result.candidates?.[0]?.finishReason;
    throw new Error(reason==='MAX_TOKENS'?'Gemini 출력 토큰 한도로 응답이 잘렸습니다.':'Gemini 응답이 차단되거나 완결되지 않았습니다.');}
  const parts=result.candidates[0]?.content?.parts;
  if(!Array.isArray(parts))throw new Error('Gemini 응답 형식 오류.');
  const text=parts.filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join('');
  let value:unknown;try{value=JSON.parse(text);}catch{throw new SchemaValidationError('모델 출력이 JSON이 아닙니다.');}
  const checked=schema.safeParse(value);
  if(!checked.success){const detail=checked.error.issues.slice(0,4).map(i=>`${i.path.join('.')||'$'} (${i.code}): ${i.message}`)
    .join('; ').replaceAll(apiKey,'[REDACTED]').slice(0,800);throw new SchemaValidationError(`Gemini 출력 스키마 오류: ${detail}`);}
  return checked.data;
}
export function fileSession(apiKey:string,stats:Metrics,budget:Budget,options:{fetcher?:typeof fetch;
  onResponse?:(kind:string,raw:unknown)=>void}={}) {
  const cache=new Map<string,Promise<string>>(),created:string[]=[];
  const json=(url:string,init:RequestInit)=>requestJson(url,init,apiKey,options.fetcher);
  const headers={'x-goog-api-key':apiKey,'Content-Type':'application/json'};
  async function upload(pdf:Uint8Array){
    if(!pdf.length||pdf.length>MAX_PDF_BYTES)throw new Error('PDF 크기 제한.');
    const sha=createHash('sha256').update(pdf).digest('hex');
    const old=cache.get(sha);if(old){stats.file_reuses++;return old;}
    const pending=(async()=>{
      const [,h]=await json(BASE_URL+'/upload/v1beta/files',{method:'POST',headers:{...headers,
        'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start',
        'X-Goog-Upload-Header-Content-Length':String(pdf.length),'X-Goog-Upload-Header-Content-Type':'application/pdf'},
        body:JSON.stringify({file:{display_name:'portfolio-'+sha.slice(0,12)}})});
      let url:URL;try{url=new URL(h.get('X-Goog-Upload-URL')??'');}catch{throw new Error('업로드 주소 오류.');}
      if(url.origin!==BASE_URL||!url.pathname.startsWith('/upload/')||url.username||url.password)throw new Error('신뢰할 수 없는 업로드 주소.');
      const [result]=await json(url.href,{method:'POST',headers:{'Content-Type':'application/pdf','X-Goog-Upload-Offset':'0',
        'X-Goog-Upload-Command':'upload, finalize'},body:Buffer.from(pdf)});
      let info=result.file;
      if(!info||typeof info.name!=='string'||!/^files\/[A-Za-z0-9_-]+$/.test(info.name))throw new Error('파일 식별자 오류.');
      const name=info.name;created.push(name);stats.uploads++;stats.uploaded_bytes+=pdf.length;
      const deadline=Date.now()+60_000;
      while(info.state==='PROCESSING'){
        if(Date.now()>=deadline)throw new Error('Files API 처리 시간 초과.');
        await delay(1000);[info]=await json(BASE_URL+'/v1beta/'+name,{headers});
      }
      if(info.state!=='ACTIVE'||info.uri!==BASE_URL+'/v1beta/'+name)throw new Error('업로드 PDF가 ACTIVE 상태가 아닙니다.');
      return info.uri as string;
    })();cache.set(sha,pending);return pending;
  }
  const generate:Generate=async request=>{
    validateConfig(apiKey,request.model);priceFor(request.model);
    if(budget.blocked)throw new BudgetError('비용 미확인으로 호출이 중단되었습니다.');
    const payload=buildPayload(request.pdf?{...request,pdf:undefined,pdf_uri:await upload(request.pdf)}:request);
    const [tokens]=await json(`${BASE_URL}/v1beta/models/${request.model}:countTokens`,{method:'POST',headers,
      body:JSON.stringify({generateContentRequest:{model:'models/'+request.model,...payload}})});
    if(!count(tokens.totalTokens))throw new BudgetError('입력 토큰 수를 확인할 수 없습니다.');
    const reservation=budget.reserve(request.model,tokens.totalTokens,payload.generationConfig.maxOutputTokens);
    let result:Record<string,any>;
    try{[result]=await json(`${BASE_URL}/v1beta/models/${request.model}:generateContent`,{method:'POST',headers,body:JSON.stringify(payload)});}
    catch(e){budget.block('generation_usage_unknown');throw e;}
    const usage=result.usageMetadata;
    stats.usage.push({stage:request.kind,model:request.model,...(usage&&typeof usage==='object'?usage:{})});
    try { stats.estimated_cost_usd+=budget.settle(reservation,request.model,usage);
      stats.total_tokens+=usage.totalTokenCount;stats.input_tokens+=usage.promptTokenCount;stats.output_tokens+=usage.candidatesTokenCount;
      stats.thinking_tokens+=usage.thoughtsTokenCount??0;stats.cached_tokens+=usage.cachedContentTokenCount??0; }
    finally { options.onResponse?.(request.kind,result); }
    return parseModelResponse(result,request.schema,apiKey);
  };
  async function close(){for(const name of created.splice(0).reverse())try{await json(BASE_URL+'/v1beta/'+name,{method:'DELETE',headers});}
    catch{stats.cleanup_failures++;}}
  return {generate,close};
}
