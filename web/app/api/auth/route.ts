import { NextResponse } from "next/server";
import { authClient, currentUser, requireUser, appOrigin } from "@/lib/server/auth";
import { sameOrigin } from "@/lib/server/runner";
import { ensureMember } from "@/lib/server/database";
import { contestSettings } from '@/lib/server/contest';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET() {
  if (contestSettings().enabled) return json({ user: null, configured: true, contest: true });
  try {
    const user = await currentUser();
    if (user) await ensureMember(user.id, user.authId);
    return json({ user: user ? { email: user.email, name: user.name } : null, configured: true });
  } catch { return json({ user: null, configured: false }); }
}
export async function POST(request: Request) {
  if (contestSettings().enabled) return json({ error: '대회 체험에는 회원가입이나 로그인이 필요 없어요.' }, 404);
  if (!sameOrigin(request)) return json({ error: "같은 사이트에서만 로그인할 수 있어요." }, 403);
  const text = await request.text();
  if (text.length > 4096) return json({ error: "요청이 너무 커요." }, 413);
  let body: { action?: string; email?: string; password?: string };
  try { body = JSON.parse(text); } catch { return json({ error: "잘못된 요청이에요." }, 400); }
  if (!body || typeof body!=='object' || Array.isArray(body)) return json({error:'잘못된 요청이에요.'},400);
  try {
    const client = await authClient();
    if (body.action === 'password') {
      await requireUser();
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) return json({ error: '비밀번호는 8~128자예요.' }, 400);
      const { error } = await client.auth.updateUser({ password: body.password });
      return error ? json({ error: '비밀번호를 바꾸지 못했어요.' }, 400) : json({ ok: true, message: '비밀번호를 변경했어요.' });
    }
    if (body.action === "logout") {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) return json({ error: "로그아웃하지 못했어요. 다시 시도해주세요." }, 503);
      return json({ ok: true });
    }
    if (!["signin", "signup", "reset"].includes(body.action ?? "") || typeof body.email !== "string" ||
      body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return json({ error: "이메일을 확인해주세요." }, 400);
    if (body.action === "reset") {
      const { error } = await client.auth.resetPasswordForEmail(body.email, { redirectTo: `${appOrigin(request)}/auth/callback?recovery=1` });
      return error ? json({ error: "메일을 보내지 못했어요. 잠시 후 다시 시도해주세요." }, 429) : json({ message: "가입된 이메일이면 비밀번호 재설정 안내가 전송돼요." });
    }
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128)
      return json({ error: "비밀번호는 8~128자로 입력해주세요." }, 400);
    const credentials = { email: body.email, password: body.password };
    const response = body.action === "signup"
      ? await client.auth.signUp({ ...credentials, options: { emailRedirectTo: `${appOrigin(request)}/auth/callback` } })
      : await client.auth.signInWithPassword(credentials);
    if (response.error) return json({ error: body.action === "signup" ? "가입하지 못했어요. 이메일 확인 또는 잠시 후 다시 시도해주세요." : "로그인 정보를 확인해주세요. 이메일 인증이 필요할 수 있어요." }, 400);
    const user = await currentUser();
    if (user) await ensureMember(user.id, user.authId);
    return json({ ok: true, message: user ? "로그인했어요." : "이메일의 인증 링크를 눌러 가입을 완료해주세요." });
  } catch { return json({ error: "로그인 서버에 연결하지 못했어요. 설정을 확인해주세요." }, 503); }
}
