import { NextResponse } from "next/server";
import { authClient, appOrigin } from "@/lib/server/auth";
import { contestSettings } from '@/lib/server/contest';

export const runtime = "nodejs";
export async function GET(request: Request) {
  if(contestSettings().enabled)return NextResponse.redirect(new URL('/',request.url));
  const url = new URL(request.url), origin = appOrigin(request), code = url.searchParams.get("code");
  try {
    if (code) {
      const { error } = await (await authClient()).auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(`${origin}/${url.searchParams.get("recovery") === "1" ? "?recovery=1" : ""}`);
    }
  } catch { /* Never expose OAuth code, tokens or provider diagnostics. */ }
  return NextResponse.redirect(`${origin}/?auth_error=1`);
}
