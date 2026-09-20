import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Account } from "../types.ts";
import { ADMIN_COOKIE, verifyAdminToken } from "./auth.ts";
import { getAccount } from "./accounts.ts";
import { sessionSecret } from "./secret.ts";

export async function currentAccount(): Promise<Account | null> {
  const jar = await cookies();
  const session = verifyAdminToken(jar.get(ADMIN_COOKIE)?.value, await sessionSecret());
  return session ? getAccount(session.accountId) : null;
}

/** 서버 컴포넌트에서 담당자 세션이 없으면 로그인으로 보낸다. */
export async function requireAdmin(): Promise<Account> {
  const account = await currentAccount();
  if (!account) redirect("/login");
  return account;
}
