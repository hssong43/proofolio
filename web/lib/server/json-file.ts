import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** 임시 파일(wx)에 쓴 뒤 rename으로 교체한다. 부분 쓰기가 보이지 않는다. */
export async function writeJsonAtomic(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

/** 파일이 없거나 JSON이 아니면 null. */
export async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}
