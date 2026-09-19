import { NextResponse } from "next/server";
import { DEFAULT_MAX_QUESTIONS, startRun } from "@/lib/server/runner";
import type { Track } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 50_000_000;

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const track = form.get("track");
  const maxQuestionsRaw = Number(form.get("maxQuestions") ?? DEFAULT_MAX_QUESTIONS);
  if (!(file instanceof File)) return NextResponse.json({ error: "PDF 파일이 필요해요." }, { status: 400 });
  if (track !== "design" && track !== "marketing") return NextResponse.json({ error: "지원하지 않는 직무예요." }, { status: 400 });
  if (file.size === 0 || file.size > MAX_PDF_BYTES) return NextResponse.json({ error: "PDF는 50MB 이하여야 해요." }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.subarray(0, 5).every((b, i) => b === "%PDF-".charCodeAt(i))) return NextResponse.json({ error: "PDF 파일만 올릴 수 있어요." }, { status: 400 });
  const maxQuestions = Number.isInteger(maxQuestionsRaw) && maxQuestionsRaw >= 1 && maxQuestionsRaw <= 20 ? maxQuestionsRaw : DEFAULT_MAX_QUESTIONS;
  try {
    const status = await startRun({ bytes, fileName: file.name, track: track as Track, maxQuestions });
    return NextResponse.json({ runId: status.runId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
