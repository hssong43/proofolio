import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { loadRuntimeEnv } from "../../../src/env.ts";
import { ROOT, AnswerError } from "./runner.ts";

// Auth lives entirely in route handlers: cookie refresh is writable here and no server key reaches React.
export async function authClient() {
  loadRuntimeEnv(ROOT);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AnswerError("로그인 서버 설정이 필요해요.", 503);
  const jar = await cookies();
  return createServerClient(url, key, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: process.env.PROOFOLIO_APP_URL?.startsWith("https://") ?? false },
    cookies: { getAll: () => jar.getAll(), setAll: values => values.forEach(({ name, value, options }) => jar.set(name, value, options)) },
  });
}

export const memberId = (authId: string) => createHash("sha256").update(`auth:${authId}`).digest("hex");
export async function currentUser() {
  const client = await authClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { id: memberId(data.user.id), authId: data.user.id, email: data.user.email ?? "", name: data.user.user_metadata?.full_name ?? "" };
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new AnswerError("로그인 후 이용해주세요.", 401);
  return user;
}
export function appOrigin(request: Request) {
  if (!process.env.PROOFOLIO_APP_URL && !['localhost','127.0.0.1'].includes(new URL(request.url).hostname))
    throw new AnswerError('PROOFOLIO_APP_URL에 서비스 주소를 설정해주세요.',503);
  const url = new URL(process.env.PROOFOLIO_APP_URL || request.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new AnswerError("PROOFOLIO_APP_URL에 서비스 주소를 설정해주세요.", 503);
  if (url.username || url.password) throw new AnswerError("서비스 주소 설정 오류예요.", 503);
  return url.origin;
}
