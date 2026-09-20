import { NextResponse } from 'next/server';
import { requireUser } from './auth';
import { ensureMember } from './database';
import { AnswerError, sameOrigin } from './runner';
import { contestSettings } from './contest';

export async function recruitingRoute(request: Request, action: (userId: string) => Promise<unknown>) {
  try {
    if(contestSettings().enabled)throw new AnswerError('대회 체험에서는 채용 기능을 공개하지 않아요.',404);
    if(request.method!=='GET'&&!sameOrigin(request))throw new AnswerError('같은 사이트에서만 요청할 수 있어요.',403);
    const user=await requireUser();
    await ensureMember(user.id,user.authId);
    const body=await action(user.id);
    return NextResponse.json(body,{headers:{'Cache-Control':'private, no-store'}});
  }catch(e){
    return NextResponse.json({error:e instanceof AnswerError?e.message:'채용 데이터에 연결하지 못했어요. SQL 003 적용과 서버 설정을 확인해주세요.'},
      {status:e instanceof AnswerError?e.status:503,headers:{'Cache-Control':'private, no-store'}});
  }
}
export async function recruitingBody(request: Request): Promise<Record<string, unknown>> {
  if(Number(request.headers.get('content-length'))>4096)throw new AnswerError('요청이 너무 커요.',413);
  const text=await request.text();
  if(text.length>4096)throw new AnswerError('요청이 너무 커요.',413);
  let value: unknown;
  try {value=JSON.parse(text);}catch{throw new AnswerError('잘못된 요청이에요.',400);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AnswerError('잘못된 요청이에요.',400);
  return value as Record<string, unknown>;
}
