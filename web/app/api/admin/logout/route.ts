import { sameOrigin } from "@/lib/server/runner";
import { ADMIN_COOKIE, cookieHeader } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response("cross-origin", { status: 403 });
  return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": cookieHeader(ADMIN_COOKIE, "", request, 0) } });
}
