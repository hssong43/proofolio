import { sameOrigin } from "@/lib/server/runner";
import { ADMIN_COOKIE, ADMIN_TTL_MS, cookieHeader, issueAdminToken } from "@/lib/server/auth";
import { createAccount, SignupError } from "@/lib/server/accounts";
import { sessionSecret } from "@/lib/server/secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirect = (location: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { Location: location, ...headers } });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response("cross-origin", { status: 403 });
  const form = await request.formData();
  const field = (name: string) => form.get(name);
  try {
    const account = await createAccount({ email: field("email"), password: field("password"), passwordConfirm: field("passwordConfirm"), name: field("name"), company: field("company") });
    return redirect("/", { "Set-Cookie": cookieHeader(ADMIN_COOKIE, issueAdminToken(account.id, await sessionSecret()), request, ADMIN_TTL_MS / 1000) });
  } catch (e) {
    const code = e instanceof SignupError ? e.code : "unknown";
    return redirect(`/login?tab=signup&error=${code}`);
  }
}
