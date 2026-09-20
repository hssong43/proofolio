import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, verifyAdminToken } from "./auth.ts";

/** 서버 컴포넌트에서 담당자 세션이 없으면 로그인으로 보낸다. */
export async function requireAdmin() {
  const jar = await cookies();
  if (!verifyAdminToken(jar.get(ADMIN_COOKIE)?.value)) redirect("/login");
}

export function adminConfigured() {
  return !!process.env.PROOFOLIO_ADMIN_PASSWORD;
}
