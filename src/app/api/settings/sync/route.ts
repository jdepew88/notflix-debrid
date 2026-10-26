import { NextRequest, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { requireOwner } from "@/lib/config-access";
import { getServerSettingsSync, normalizePlaybackSettings, readPlaybackSettings, savePlaybackSettings, toClientSettings } from "@/lib/server-settings";
import { pushEngineRuntimeConfig } from "@/lib/media-engine/client";

export const dynamic = "force-dynamic";

/**
 * Playback behaviour for the browser (no credentials, paths or URLs), plus whether this viewer
 * may manage the server. Every signed-in account can read it.
 */
export async function GET() {
  const viewer = await getViewer();
  const settings = getServerSettingsSync();
  return NextResponse.json({
    settings: toClientSettings(settings),
    canManageServer: viewer?.role === "owner",
    configured: { tmdb: Boolean(settings.tmdbApiKey), debrid: Boolean(settings.realDebridToken) },
  });
}

/** Server-wide playback defaults (owner only). Credentials are managed under /api/config/*. */
export async function POST(request: NextRequest) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const next = savePlaybackSettings(normalizePlaybackSettings(body, readPlaybackSettings()));
  // Engine limits apply immediately; no restart needed.
  const engineUpdated = await pushEngineRuntimeConfig({
    maxConcurrentVideoTranscodes: next.maxConcurrentTranscodes,
    hardwareAcceleration: next.hardwareAcceleration,
    hardwareDevice: next.hardwareDevice,
  });
  return NextResponse.json({ success: true, settings: toClientSettings(getServerSettingsSync()), engineUpdated });
}
