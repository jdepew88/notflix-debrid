import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { EngineRequestError, EngineUnavailableError, engineJson, mintTicket } from "@/lib/media-engine/client";
import { registerSession } from "@/lib/media-engine/registry";
import { mergeSettingsForServerOps } from "@/lib/settings";
import type { EngineSessionView } from "@/lib/playback-orchestrator";

export const dynamic = "force-dynamic";

/** Generated self-test media (scripts/generate-test-media.mjs). */
function sampleDir(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), "test-media");
}

const MEDIA_EXT = /\.(mp4|mkv|webm|ts|avi|mov|m4v)$/i;

/** Lists playable sample files for Settings → Playback self-test. */
export async function GET() {
  const dir = sampleDir();
  let notes: Record<string, string> = {};
  try {
    notes = Object.fromEntries(
      (JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Array<{ name: string; note: string }>).map((s) => [s.name, s.note])
    );
  } catch {
    /* manifest optional */
  }
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => MEDIA_EXT.test(f)).sort()
    : [];
  return NextResponse.json({
    samples: files.map((name) => ({ name, note: notes[name] ?? "", sizeBytes: fs.statSync(path.join(dir, name)).size })),
    generateHint: files.length ? undefined : "Run: node scripts/generate-test-media.mjs",
  });
}

/** Starts an engine session for a sample file, exactly like a real title. */
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { name?: string; client?: unknown; forceMode?: string; startSeconds?: number };
  const name = typeof body.name === "string" ? path.basename(body.name) : "";
  const file = path.join(sampleDir(), name);
  if (!MEDIA_EXT.test(name) || !fs.existsSync(file)) return NextResponse.json({ error: "Unknown sample" }, { status: 404 });

  const settings = mergeSettingsForServerOps();
  try {
    const created = await engineJson<EngineSessionView & { token: string }>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: mintTicket({ kind: "file", path: file, provider: "sample", fileName: name, title: name }, userId),
        client: body.client,
        preferences: {
          maxHeight: settings.maxResolution,
          quality: settings.playbackQuality,
          hardwareAcceleration: settings.hardwareAcceleration,
          allowDirectPlay: settings.directPlay !== false,
          audioLanguage: settings.audioLanguage,
          forceMode: ["remux", "audio", "video"].includes(body.forceMode ?? "") ? body.forceMode : undefined,
        },
        startSeconds: typeof body.startSeconds === "number" ? body.startSeconds : 0,
      }),
      timeoutMs: 90_000,
    });
    const { token, ...session } = created;
    registerSession({ id: session.id, token, owner: userId, title: name, provider: "sample", sourceKey: file });
    const base = `/api/playback/${session.id}`;
    return NextResponse.json({
      ok: true,
      session,
      urls: session.output === "hls" ? { manifest: `${base}/manifest?generation=${session.generation}` } : { stream: `${base}/stream` },
    });
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      return NextResponse.json({ ok: false, error: "The media engine is offline.", code: "engine-offline" }, { status: 503 });
    }
    const e = err instanceof EngineRequestError ? err : null;
    return NextResponse.json({ ok: false, error: e?.message ?? "Sample failed", code: e?.code ?? "error" }, { status: e?.status ?? 500 });
  }
}
