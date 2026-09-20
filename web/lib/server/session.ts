import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "proofolio_session";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Cookie is a bearer secret; only its one-way hash is saved as the guest user ID. */
export function sessionUser(request: Request, create = false) {
  const existing = request.headers.get("cookie")?.split(/;\s*/)
    .find(value => value.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  const token = existing && TOKEN.test(existing) ? existing : create ? randomBytes(32).toString("base64url") : null;
  return token ? { token, id: createHash("sha256").update(token).digest("hex") } : null;
}

export function sessionCookie(request: Request, token: string) {
  return { name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: "lax" as const, path: "/",
    secure: new URL(request.url).protocol === "https:", maxAge: 60 * 60 * 24 * 30 };
}
