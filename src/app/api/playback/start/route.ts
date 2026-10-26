import { NextRequest, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isRestricted } from "@/lib/maturity";
import { RESTRICTED_RESPONSE, titleAllowed } from "@/lib/maturity-server";
import { mergeSettingsForServerOps } from "@/lib/settings";
import { startPlayback, type ClientCapabilities } from "@/lib/playback-orchestrator";

export const dynamic = "force-dynamic";

const CODEC = /^[a-z0-9_]{2,16}$/;

function sanitizeCaps(raw: unknown): ClientCapabilities {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown, fallback: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && CODEC.test(x)).slice(0, 16) : fallback;
  return {
    directVideo: list(r.directVideo, ["h264"]),
    directAudio: list(r.directAudio, ["aac", "mp3"]),
    mseVideo: list(r.mseVideo, ["h264"]),
    mseAudio: list(r.mseAudio, ["aac", "mp3"]),
    tenBit: list(r.tenBit, []),
    hdrDisplay: r.hdrDisplay === true,
    mse: r.mse !== false,
    nativeHls: r.nativeHls === true,
    maxHeight: typeof r.maxHeight === "number" && r.maxHeight > 0 ? Math.min(4320, r.maxHeight) : undefined,
  };
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined);

/**
 * Starts playback for a title: searches the enabled release sources through the debrid provider,
 * resolves a playable file, and opens a media-engine session that plays it the cheapest way the
 * viewer's browser allows. One request, so pressing Play needs a single round trip.
 */
export async function POST(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const userId = viewer.user.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const type = body.type === "series" ? "series" : "movie";
  const tmdbId = int(body.tmdbId);
  const title = typeof body.title === "string" ? body.title.slice(0, 300) : undefined;
  const torrentId = typeof body.torrentId === "string" && /^[A-Z0-9]{6,40}$/i.test(body.torrentId) ? body.torrentId : undefined;
  if (!tmdbId && !title && !torrentId) {
    return NextResponse.json({ error: "Missing title information", code: "bad-request" }, { status: 400 });
  }
  // Restricted profiles play only titles whose rating is known to be within their level.
  if (isRestricted(viewer.maturity)) {
    const apiKey = mergeSettingsForServerOps().tmdbApiKey?.trim() || undefined;
    if (!tmdbId || !(await titleAllowed(viewer.maturity, apiKey, tmdbId, type === "series" ? "tv" : "movie"))) {
      return NextResponse.json({ ...RESTRICTED_RESPONSE, ok: false }, { status: 403 });
    }
  }

  const result = await startPlayback(
    {
      userId,
      watchId: typeof body.watchId === "string" ? body.watchId.slice(0, 200) : tmdbId ? `tmdb-${tmdbId}` : "stream",
      request: {
        tmdbId,
        type,
        season: int(body.season),
        episode: int(body.episode),
        title,
        year: int(body.year),
        seriesId: typeof body.seriesId === "string" ? body.seriesId.slice(0, 200) : undefined,
      },
      torrentId,
      streamIndex: int(body.streamIndex),
      client: sanitizeCaps(body.client),
      startSeconds: typeof body.startSeconds === "number" && body.startSeconds > 0 ? body.startSeconds : 0,
      audioIndex: int(body.audioIndex),
      subtitleIndex: int(body.subtitleIndex),
      // Preferences come from the profile this browser verifiably selected, not a client-supplied id.
      profileId: viewer.profile?.id,
      maxResolution: [2160, 1440, 1080, 720, 480].includes(Number(body.maxResolution)) ? Number(body.maxResolution) : undefined,
    },
    mergeSettingsForServerOps()
  );

  if (!result.ok) {
    const status = result.code === "engine-offline" ? 503 : result.code.startsWith("debrid-auth") ? 401 : 404;
    return NextResponse.json(result, { status: status === 401 ? 409 : status });
  }
  return NextResponse.json(result);
}
