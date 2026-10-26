import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { getDataPath } from "@/lib/data-path";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;

/** Strips anything that looks like a URL or token before a report is stored. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") {
    return value
      .replace(/https?:\/\/[^\s"']+/g, "[url]")
      .replace(/(token|key|secret|authorization)=([^&\s"']+)/gi, "$1=[redacted]")
      .slice(0, 2000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !/token|secret|password|cookie/i.test(k))
        .slice(0, 80)
        .map(([k, v]) => [k, scrub(v, depth + 1)])
    );
  }
  return value;
}

/** "Report playback problem": appends a scrubbed diagnostics snapshot to data/playback-reports.jsonl. */
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const text = await request.text();
  if (text.length > 200_000) return NextResponse.json({ error: "Report too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid report" }, { status: 400 });
  }
  const file = path.join(getDataPath(), "playback-reports.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Bounded: keep the current file and one previous generation (at most ~2 × MAX_REPORT_BYTES).
  try {
    if (fs.statSync(file).size > MAX_REPORT_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no file yet */
  }
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), user: userId, report: scrub(body) }) + "\n");
  return NextResponse.json({ ok: true });
}
