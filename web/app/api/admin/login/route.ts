import { setTimeout as delay } from "node:timers/promises";
import { sameOrigin } from "@/lib/server/runner";
import { ADMIN_COOKIE, ADMIN_TTL_MS, adminPassword, checkPassword, cookieHeader, issueAdminToken } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirect = (location: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { Location: location, ...headers } });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response("cross-origin", { status: 403 });
  try {
    adminPassword();
  } catch {
    return redirect("/login?error=env");
  }
  const form = await request.formData();
  const password = form.get("password");
  if (typeof password === "string" && checkPassword(password)) {
    return redirect("/", { "Set-Cookie": cookieHeader(ADMIN_COOKIE, issueAdminToken(), request, ADMIN_TTL_MS / 1000) });
  }
  await delay(300);
  return redirect("/login?error=1");
}
