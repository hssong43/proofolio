import {randomUUID} from 'node:crypto';
import {appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import * as z from 'zod';

export const MAX_OUTPUT_TOKENS=16384;
export class SchemaValidationError extends Error {}
export class BudgetError extends Error {}
export class HttpResponseError extends Error {
  readonly status:number;
  readonly request_id:string|null;
  readonly generation_id:string|null;
  readonly usage:unknown;
  readonly diagnostics:Record<string,string|number|null>;
  readonly retry_after_ms:number|null;
  constructor(message:string,status:number,requestId:string|null,usage?:unknown,generationId:string|null=null,diagnostics:Record<string,string|number|null>={},retryAfter:number|null=null){
    super(message);this.status=status;this.request_id=requestId;this.generation_id=generationId;this.usage=usage;this.diagnostics=diagnostics;this.retry_after_ms=retryAfter;
  }
}
export type Usage = {promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number;
  cachedContentTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; [key:string]:unknown};
export type Metrics = {model_calls:number; uploads:number; uploaded_bytes:number; file_reuses:number;
  cleanup_failures:number; usage:Array<Record<string,unknown>>; first_evidence_ms:number|null;
  total_ms?:number; stages:Array<{stage:string; elapsed_ms:number; attempt:number}>; estimated_cost_usd:number;
  total_tokens:number;input_tokens:number;output_tokens:number;thinking_tokens:number|null;cached_tokens:number};
export const freshMetrics = ():Metrics => ({model_calls:0,uploads:0,uploaded_bytes:0,file_reuses:0,cleanup_failures:0,
  usage:[],first_evidence_ms:null,stages:[],estimated_cost_usd:0,total_tokens:0,input_tokens:0,output_tokens:0,thinking_tokens:0,cached_tokens:0});
export function priceFor(model:string, now=new Date(), inputTokens=0) {
  // Verified standard API rates, no Batch/priority/search/tools or explicit cache storage.
  // https://ai.google.dev/gemini-api/docs/pricing (2026-09-19)
  if(!['gemini-3.8-flash','gemini-3.7-flash','gemini-3.1-pro-preview','claude-opus-5'].includes(model) || now.toISOString().slice(0,10)>'2026-12-31'
    ||!Number.isSafeInteger(inputTokens)||inputTokens<0)
    throw new BudgetError('모델 가격표를 확인할 수 없거나 만료되었습니다. 호출을 중단합니다.');
  // Historical standard rates for stored report accounting; OpenRouter validates live endpoint prices.
  // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing (2026-09-19)
  if(model==='claude-opus-5')return {input:5,output:25,cached:.5};
  if(model==='gemini-3.1-pro-preview')return inputTokens>200_000?{input:4,output:18,cached:.4}:{input:2,output:12,cached:.2};
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
  const rates=priceFor(model,new Date(),u.promptTokenCount);
  // total minus input captures thinking even when older responses omit thoughtsTokenCount.
  const output=Math.max(u.candidatesTokenCount+thoughts,u.totalTokenCount-u.promptTokenCount);
  return ((u.promptTokenCount-cached)*rates.input+cached*rates.cached+output*rates.output)/1e6;
}
type ApprovedExtension = {type:'approved_extension';approval_id:string;usd:number;baseline_usd:number;
  limit_krw:number;krw_per_usd:number;previous_ceiling_usd:number};
type ApprovedHold = {type:'approved_unknown_cost_hold';approval_id:string;id:string;usd:number};
type LedgerEvent = {type:'header';version:1;limit_usd:number;provider?:'openrouter'}|{type:'reserve';id:string;usd:number;model:string;at:string}
  |{type:'settle';id:string;usd:number}|{type:'blocked';reason:string}
  |{type:'ceiling';usd:number;baseline_usd:number;limit_krw:number;krw_per_usd:number}|ApprovedExtension|ApprovedHold;
export class Budget {
  private readonly initialLimit:number;
  readonly path:string;
  readonly provider:'openrouter'|undefined;
  spent=0;
  readonly pending=new Map<string,number>();
  private holds=new Map<string,ApprovedHold>();
  private blockReasons=new Set<string>();
  blocked=false;
  private lock:string;
  private closed=false;
  private ceiling:number;
  private window:Extract<LedgerEvent,{type:'ceiling'}>|undefined;
  private extension:ApprovedExtension|undefined;
  private approvals=new Map<string,ApprovedExtension>();
  constructor(path:string,limit=10,provider?:'openrouter') {
    if(!Number.isFinite(limit)||limit<=0||limit>10) throw new BudgetError('이 작업 예산은 0 초과 10달러 이하입니다.');
    this.path=path;this.provider=provider; this.initialLimit=limit; this.ceiling=limit; this.lock=path+'.lock';
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const fd=openSync(this.lock,'wx',0o600); closeSync(fd);
    try {
      if(!existsSync(path)) writeFileSync(path,JSON.stringify({type:'header',version:1,limit_usd:limit,...(provider?{provider}:{})})+'\n',{flag:'wx',mode:0o600});
      const rows=readFileSync(path,'utf8').trim().split('\n').map(s=>JSON.parse(s)) as LedgerEvent[];
      const header=rows.shift();
      if(header?.type!=='header'||header.version!==1||header.limit_usd!==limit||header.provider!==provider) throw new BudgetError('예산 원장 형식, 공급자 또는 한도가 다릅니다.');
      for(const row of rows) this.apply(row);
      if(this.pending.size&&!this.blocked)this.block('unsettled_previous_process');
      if(this.spent+this.reserved>this.ceiling+1e-9) this.blocked=true;
    } catch(e) { unlinkSync(this.lock); throw e; }
  }
  get limit(){return this.extension?.usd??this.initialLimit;}
  get activeReserved(){return [...this.pending.values()].reduce((a,b)=>a+b,0);}
  get unknownCostHold(){return [...this.holds.values()].reduce((a,b)=>a+b.usd,0);}
  get reserved(){return this.activeReserved+this.unknownCostHold;}
  get remaining(){return Math.max(0,this.ceiling-this.spent-this.reserved);}
  // Explicit user approval keeps the entire unknown reservation unavailable; it is NOT a settlement.
  approveUnknownCostHold(approvalId:string,id:string,usd:number){
    if(this.closed)throw new BudgetError('종료된 예산 원장입니다.');
    const old=[...this.holds.values()].find(h=>h.approval_id===approvalId);
    if(old){if(old.id!==id||old.usd!==usd)throw new BudgetError('기존 미확인 비용 유보 승인과 다릅니다.');return;}
    const row:ApprovedHold={type:'approved_unknown_cost_hold',approval_id:approvalId,id,usd};
    this.validateHold(row);this.append(row);
  }
  private validateHold(row:ApprovedHold){
    if(this.provider!=='openrouter'||!this.blocked||this.blockReasons.size!==1||!this.blockReasons.has('openrouter_generation_usage_unknown')||
      typeof row.approval_id!=='string'||!/^[a-z0-9_-]{1,100}$/.test(row.approval_id)||[...this.holds.values()].some(h=>h.approval_id===row.approval_id)||
      this.pending.size!==1||this.holds.has(row.id)||this.pending.get(row.id)!==row.usd||!Number.isFinite(row.usd)||row.usd<=0||
      this.spent+this.reserved>this.ceiling+1e-9)throw new BudgetError('미확인 비용 유보 승인 또는 예약 상태가 유효하지 않습니다.');
  }
  capAdditionalKrw(limit:number,krwPerUsd:number) {
    if(!Number.isFinite(limit)||limit<=0||!Number.isFinite(krwPerUsd)||krwPerUsd<=0||this.closed||this.blocked||this.pending.size)
      throw new BudgetError('안전한 추가 예산 창을 만들 수 없습니다.');
    if(this.window){if(this.window.limit_krw!==limit||this.window.krw_per_usd!==krwPerUsd)throw new BudgetError('기존 추가 예산 창과 설정이 다릅니다.');return;}
    this.append({type:'ceiling',usd:Math.min(this.limit,this.spent+limit/krwPerUsd),baseline_usd:this.spent,limit_krw:limit,krw_per_usd:krwPerUsd});
  }
  // Explicit operator approval only, never called automatically by analysis or a retry.
  approveAdditionalKrw(approvalId:string,limitKrw:number,krwPerUsd:number) {
    if(this.closed)throw new BudgetError('종료된 예산 원장입니다.');
    const old=this.approvals.get(approvalId);
    if(old){if(old.limit_krw!==limitKrw||old.krw_per_usd!==krwPerUsd)throw new BudgetError('기존 승인 ID와 금액이 다릅니다.');return;}
    const row:ApprovedExtension={type:'approved_extension',approval_id:approvalId,usd:this.spent+limitKrw/krwPerUsd,
      baseline_usd:this.spent,limit_krw:limitKrw,krw_per_usd:krwPerUsd,previous_ceiling_usd:this.ceiling};
    this.validateExtension(row);this.append(row);
  }
  private validateExtension(row:ApprovedExtension) {
    if(typeof row.approval_id!=='string'||!/^[a-z0-9_-]{1,100}$/.test(row.approval_id)||this.approvals.has(row.approval_id)||!this.window||this.blocked||this.pending.size||
      !Number.isSafeInteger(row.limit_krw)||row.limit_krw<=0||!Number.isFinite(row.krw_per_usd)||row.krw_per_usd<=0||
      row.baseline_usd!==this.spent||row.previous_ceiling_usd!==this.ceiling||!Number.isFinite(row.usd)||row.usd<=this.ceiling||
      row.usd!==row.baseline_usd+row.limit_krw/row.krw_per_usd)throw new BudgetError('추가 승인 기록 또는 예산 상태가 유효하지 않습니다.');
  }
  private apply(row:LedgerEvent) {
    if(row.type==='blocked'){this.blocked=true;this.blockReasons.add(row.reason);return;}
    if(row.type==='approved_unknown_cost_hold'){
      this.validateHold(row);this.pending.delete(row.id);this.holds.set(row.id,row);
      this.blocked=false;this.blockReasons.clear();return;
    }
    if(row.type==='ceiling'){
      if(this.window||!Number.isFinite(row.usd)||row.usd<this.spent||row.usd>this.limit||row.baseline_usd!==this.spent||
        !Number.isFinite(row.limit_krw)||row.limit_krw<=0||!Number.isFinite(row.krw_per_usd)||row.krw_per_usd<=0||
        row.usd!==Math.min(this.limit,row.baseline_usd+row.limit_krw/row.krw_per_usd))throw new BudgetError('추가 예산 창 오류.');
      this.window=row;this.ceiling=row.usd;return;
    }
    if(row.type==='approved_extension'){
      this.validateExtension(row);this.approvals.set(row.approval_id,row);this.extension=row;this.ceiling=row.usd;return;
    }
    if(row.type==='header'||!Number.isFinite(row.usd)||row.usd<0) throw new BudgetError('예산 원장 오류.');
    if(row.type==='reserve') {
      if(this.pending.has(row.id)||this.holds.has(row.id)) throw new BudgetError('중복 예산 예약.');
      this.pending.set(row.id,row.usd);
    } else if(row.type==='settle') {
      if(!this.pending.has(row.id)) throw new BudgetError('예약 없는 비용 정산.');
      this.pending.delete(row.id);this.spent+=row.usd;
    } else throw new BudgetError('알 수 없는 예산 원장 이벤트.');
  }
  private append(row:LedgerEvent){appendFileSync(this.path,JSON.stringify(row)+'\n',{mode:0o600,flush:true});this.apply(row);}
  reserve(model:string,input:number,maxOutput=MAX_OUTPUT_TOKENS) {
    if(!count(input)||!count(maxOutput)||maxOutput<1) throw new BudgetError('입력/최대 출력 토큰을 확인할 수 없습니다.');
    const rates=priceFor(model,new Date(),input), usd=(input*rates.input+maxOutput*rates.output)/1e6;
    return this.reserveUsd(model,usd);
  }
  reserveUsd(model:string,usd:number) {
    if(this.closed||this.blocked) throw new BudgetError('비용 미확인 또는 종료된 예산 원장입니다. 신규 호출을 중단합니다.');
    if(!Number.isFinite(usd)||usd<=0)throw new BudgetError('예약 비용 상한을 확인할 수 없습니다.');
    if(usd>this.remaining+1e-9) throw new BudgetError('누적/추가 예산의 남은 금액이 부족합니다.');
    const id=randomUUID();this.append({type:'reserve',id,usd,model,at:new Date().toISOString()});return id;
  }
  settle(id:string,model:string,usage:unknown) {
    let usd:number;
    try {usd=usageCost(model,usage);}catch(e){this.block('usage_unavailable');throw e;}
    return this.settleUsd(id,usd);
  }
  settleUsd(id:string,usd:number) {
    if(this.closed)throw new BudgetError('종료된 예산 원장입니다.');
    if(!Number.isFinite(usd)||usd<0){this.block('cost_unavailable');throw new BudgetError('실제 비용을 확인할 수 없습니다.');}
    const reserved=this.pending.get(id);
    if(reserved===undefined) throw new BudgetError('정산 예약이 없습니다.');
    this.append({type:'settle',id,usd});
    if(usd>reserved+1e-9||this.spent+this.reserved>this.ceiling+1e-9){this.block('reservation_exceeded');throw new BudgetError('예상 비용 상한 초과. 신규 호출을 중단합니다.');}
    return usd;
  }
  block(reason:string){if(!this.blockReasons.has(reason))this.append({type:'blocked',reason});}
  snapshot(){const window=this.extension??this.window;
    return {limit_usd:this.limit,spent_usd:this.spent,reserved_usd:this.reserved,remaining_usd:this.remaining,blocked:this.blocked,
      ...(this.holds.size?{active_reserved_usd:this.activeReserved,unknown_cost_hold_usd:this.unknownCostHold,held_request_actual_cost_usd:null}:{}),
      ...(this.extension?{initial_limit_usd:this.initialLimit}:{}),
      ...(window?{spend_window:window,additional_estimated_krw:(this.spent-window.baseline_usd)*window.krw_per_usd}: {})};}
  close(){if(!this.closed){unlinkSync(this.lock);this.closed=true;}}
}

export type ModelRequest = {kind:string;schema:z.ZodType;prompt:string;model:string;pdf?:Uint8Array;pdf_uri?:string;
  images?:Array<[string,Uint8Array]>;maxOutputTokens?:number;thinkingLevel?:'LOW'|'MEDIUM'|'HIGH'};
export type Generate = (request:ModelRequest)=>Promise<unknown>;
export function retryAfterMs(value:string|null,now=Date.now()):number|null {
  if(value===null)return null;
  const text=value.trim(),ms=/^\d+$/.test(text)?Number(text)*1000:
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)?Math.max(0,Date.parse(text)-now):NaN;
  return Number.isSafeInteger(ms)&&ms>=0?ms:null;
}
export async function requestJson(url:string,init:RequestInit,apiKey:string,fetcher:typeof fetch=fetch,provider='OpenRouter'):Promise<[Record<string,any>,Headers]> {
  let response:Response;
  try {response=await fetcher(url,{...init,redirect:'error',signal:init.signal??AbortSignal.timeout(120_000)});}
  catch {throw new Error(`${provider} 연결 실패 또는 시간 초과. 자동 재시도하지 않았습니다.`);}
  const chunks:Uint8Array[]=[];let size=0;
  try {if(response.body) for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw new Error();chunks.push(chunk);}}
  catch {throw new Error(`${provider} 응답 수신 실패 또는 크기 초과.`);}
  let value:unknown;
  const safeId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(v)&&!v.includes(apiKey)?v:null;
  const headerId=safeId(response.headers.get('x-request-id'))??safeId(response.headers.get('request-id'));
  const generationId=safeId(response.headers.get('x-generation-id'));
  const retryAfter=retryAfterMs(response.headers.get('retry-after'));
  try {value=size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch {throw new HttpResponseError(`${provider} HTTP ${response.status}: 유효하지 않은 JSON.`,response.status,headerId,undefined,generationId,{},retryAfter);}
  if(!response.ok){const message=(value as any)?.error?.message; const detail=typeof message==='string'?message.replaceAll(apiKey,'[REDACTED]').slice(0,800):'인증, 모델 접근, 할당량을 확인하세요.';
    const metadata=(value as any)?.error?.metadata;
    // Whitelist codes only: raw upstream messages can contain credentials or portfolio text.
    const safeCode=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)?v:
      typeof v==='string'&&/^[A-Za-z0-9_.:/ -]{1,120}$/.test(v)&&!v.includes(apiKey)?v:null;
    let upstream:any;
    try {upstream=typeof metadata?.raw==='string'?JSON.parse(metadata.raw):metadata?.raw;}catch{}
    const diagnostics={provider_name:safeCode(metadata?.provider_name),error_type:safeCode(metadata?.error_type),
      provider_code:safeCode(metadata?.provider_code),upstream_code:safeCode(upstream?.error?.code??upstream?.code),
      upstream_status:safeCode(upstream?.error?.status??upstream?.status),upstream_type:safeCode(upstream?.error?.type??upstream?.type)};
    throw new HttpResponseError(`${provider} HTTP ${response.status}: ${detail}`,response.status,
      headerId??safeId((value as any)?.id)??safeId(metadata?.request_id),(value as any)?.usage,safeId((value as any)?.id)??generationId,diagnostics,retryAfter);}
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error(`${provider} 응답 형식 오류.`);
  return [value as Record<string,any>,response.headers];
}
