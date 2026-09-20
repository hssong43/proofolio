import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { storeDir } from "./store.ts";

const cache = new Map<string, string>();

/** 세션 서명 비밀. 환경변수가 없으면 저장소에 한 번 생성해 재사용한다. */
export async function sessionSecret(env: Record<string, string | undefined> = process.env): Promise<string> {
  if (env.PROOFOLIO_SESSION_SECRET) return env.PROOFOLIO_SESSION_SECRET;
  const file = path.join(storeDir(env), "session-secret");
  const cached = cache.get(file);
  if (cached) return cached;
  let secret: string;
  try {
    secret = (await readFile(file, "utf8")).trim();
  } catch {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const fresh = randomBytes(32).toString("hex");
    try {
      await writeFile(file, fresh + "\n", { flag: "wx", mode: 0o600 });
      secret = fresh;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      secret = (await readFile(file, "utf8")).trim();
    }
  }
  if (!secret) throw new Error("세션 비밀을 준비하지 못했어요.");
  cache.set(file, secret);
  return secret;
}
