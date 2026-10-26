import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isRestricted } from "@/lib/maturity";
import { RESTRICTED_RESPONSE, titleAllowed } from "@/lib/maturity-server";
import { enabledSourceAddons } from "@/lib/debrid";
import { mergeSettingsForServerOps } from "@/lib/settings";
import { enrichPlayResolveRequest, type PlayResolveRequest } from "@/lib/play-resolve";
import { describeProbeError, listCandidates, probeCandidate, type SourceCandidate, type VerifiedSource } from "@/lib/source-candidates";
import { orderedAudioLanguages } from "@/lib/profile-preferences";
import { getProfilePreferences } from "@/lib/users";
import { engineJson, mintTicket } from "@/lib/media-engine/client";

/** Restricted profiles may only look up releases for titles they are allowed to play. */
async function blockedForProfile(maturity: Parameters<typeof isRestricted>[0], tmdbId: number | undefined, type: string | null | undefined) {
  if (!isRestricted(maturity)) return false;
  const apiKey = mergeSettingsForServerOps().tmdbApiKey?.trim() || undefined;
  return !tmdbId || !(await titleAllowed(maturity, apiKey, tmdbId, type === "series" ? "tv" : "movie"));
}

export const dynamic = "force-dynamic";

const int = (v: string | null) => (v && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined);

function requestFromParams(params: URLSearchParams): PlayResolveRequest & { settings: ReturnType<typeof mergeSettingsForServerOps> } {
  const settings = mergeSettingsForServerOps();
  return {
    tmdbId: int(params.get("tmdbId")),
    type: params.get("type") === "series" ? "series" : "movie",
    season: int(params.get("season")),
    episode: int(params.get("episode")),
    title: params.get("title")?.slice(0, 300) || undefined,
    year: int(params.get("year")),
    seriesId: params.get("seriesId")?.slice(0, 200) || undefined,
    sourceAddons: enabledSourceAddons(),
    realDebridToken: settings.realDebridToken || undefined,
    tmdbApiKey: settings.tmdbApiKey || undefined,
    settings,
  };
}

function view(c: SourceCandidate) {
  return {
    index: c.index,
    label: c.label,
    detail: c.detail,
    quality: c.quality,
    cached: c.cached,
    hash: c.hash,
    traits: c.traits,
    hints: c.hints,
    score: Math.round(c.score),
    verified: c.verified,
    verifyError: c.verifyError,
  };
}

/** Self-test samples presented as "releases" so source switching can be tested deterministically. */
function sampleCandidates(): Array<ReturnType<typeof view>> {
  const dir = path.join(/* turbopackIgnore: true */ process.cwd(), "test-media");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(mkv|mp4|webm|ts|avi)$/i.test(f))
    .sort()
    .map((name, index) => ({
      index,
      label: name,
      detail: "local sample",
      quality: /2160/.test(name) ? "4K" : /1080|long/.test(name) ? "1080p" : "720p",
      cached: true,
      hash: `sample-${name}`,
      traits: { resolution: null, sizeGb: null, cached: true, uncached: false, videoCodec: null, hdr: false, dolbyVision: false, remux: false, webSource: false, lowQualitySource: null, audio: null, container: null, seeders: null },
      hints: { codes: [], multi: false, likelyNonEnglishOnly: false },
      score: 0,
      verified: null,
      verifyError: undefined,
    }));
}

/**
 * GET: ranked releases for a title (cheap — no probing). Verified facts are included for releases
 * probed earlier. `preferred` tells the UI which audio languages the profile wants.
 */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const prefs = getProfilePreferences(viewer.user.id, viewer.profile?.id);
  const preferred = orderedAudioLanguages(prefs);

  if (params.get("sample") === "1") {
    return NextResponse.json({ provider: "sample", preferred, candidates: sampleCandidates() });
  }

  const { settings, ...req } = requestFromParams(params);
  if (!req.tmdbId && !req.title) return NextResponse.json({ error: "tmdbId or title required" }, { status: 400 });
  if (await blockedForProfile(viewer.maturity, req.tmdbId, params.get("type"))) return NextResponse.json({ ...RESTRICTED_RESPONSE, candidates: [] }, { status: 403 });
  if (!req.realDebridToken) return NextResponse.json({ error: "Real-Debrid is not configured.", code: "debrid-not-configured", candidates: [] }, { status: 409 });
  try {
    const enriched = await enrichPlayResolveRequest(req);
    const listed = await listCandidates(enriched, {
      maxResolution: settings.maxResolution,
      quality: settings.playbackQuality,
      hevcSupported: params.get("hevc") === "1",
      audioLanguages: preferred,
    });
    return NextResponse.json({
      provider: "real-debrid",
      preferred,
      tmdbId: enriched.tmdbId,
      candidates: (listed?.candidates ?? []).map(view),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Source search failed", candidates: [] }, { status: 502 });
  }
}

/** POST: verify one release (ffprobe through the engine). Body: same query fields + streamIndex. */
export async function POST(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const userId = viewer.user.id;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.sample !== true && (await blockedForProfile(viewer.maturity, typeof body.tmdbId === "number" ? body.tmdbId : parseInt(String(body.tmdbId ?? ""), 10) || undefined, typeof body.type === "string" ? body.type : null))) {
    return NextResponse.json(RESTRICTED_RESPONSE, { status: 403 });
  }
  const params = new URLSearchParams();
  for (const k of ["tmdbId", "type", "season", "episode", "title", "year", "seriesId"]) if (body[k] != null) params.set(k, String(body[k]));
  const index = typeof body.streamIndex === "number" ? body.streamIndex : -1;
  if (index < 0) return NextResponse.json({ error: "streamIndex required" }, { status: 400 });

  if (body.sample === true) {
    const sample = sampleCandidates()[index];
    if (!sample) return NextResponse.json({ error: "Unknown sample" }, { status: 404 });
    const file = path.join(/* turbopackIgnore: true */ process.cwd(), "test-media", sample.label);
    try {
      const res = await engineJson<{ probeMs: number; source: VerifiedSource & Record<string, unknown> }>("/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: mintTicket({ kind: "file", path: file, provider: "sample", fileName: sample.label }, userId) }),
        timeoutMs: 40_000,
      });
      return NextResponse.json({ index, verified: { ...res.source, probeMs: res.probeMs, probedAt: Date.now() } });
    } catch (err) {
      return NextResponse.json({ index, verifyError: describeProbeError(err) });
    }
  }

  const { settings, ...req } = requestFromParams(params);
  if (!req.realDebridToken) return NextResponse.json({ error: "Real-Debrid is not configured." }, { status: 409 });
  const prefs = getProfilePreferences(userId, typeof body.profileId === "string" ? body.profileId : null);
  const enriched = await enrichPlayResolveRequest(req);
  const listed = await listCandidates(enriched, {
    maxResolution: settings.maxResolution,
    quality: settings.playbackQuality,
    audioLanguages: orderedAudioLanguages(prefs),
  });
  const stream = listed?.playable[index];
  if (!stream?.url) return NextResponse.json({ error: "Unknown release" }, { status: 404 });
  try {
    const verified = await probeCandidate(stream, { token: req.realDebridToken, owner: userId, season: enriched.season, episode: enriched.episode, title: enriched.title });
    return NextResponse.json({ index, verified });
  } catch (err) {
    return NextResponse.json({ index, verifyError: describeProbeError(err) });
  }
}
