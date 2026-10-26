import "server-only";
import crypto from "crypto";
import path from "path";
import { EngineRequestError, EngineUnavailableError, engineJson, mintTicket } from "./media-engine/client";
import { fetchSortedTorrentStreams, type PlayResolveRequest } from "./play-resolve";
import { resolveTorrentioStreamUrl } from "./torrentio";
import { candidateScore, parseLanguageHints, parseStreamTraits, type RankingPreferences, type StreamTraits, type LanguageHints } from "./source-ranking";
import type { StremioStream, StremioStreamOption } from "./stremio-streams";

/** Verified stream facts from the media engine's ffprobe (never from the release name). */
export interface VerifiedSource {
  container: string;
  fileSize: number | null;
  durationSeconds: number | null;
  bitrateKbps: number | null;
  video: { codec: string; width: number; height: number; bitDepth: number; frameRate: number | null; dynamicRange: string } | null;
  audio: Array<{ index: number; codec: string; channels: number; languageCode: string | null; language: string | null; title: string | null; default: boolean }>;
  subtitles: Array<{ index: number; codec: string; languageCode: string | null; kind: string; forced: boolean }>;
  audioLanguages: string[];
  subtitleLanguages: string[];
  untaggedAudioTracks: number;
  probeMs: number;
  probedAt: number;
}

export interface SourceCandidate {
  index: number;
  label: string;
  detail: string;
  quality?: string;
  cached: boolean;
  /** Stable, non-secret identifier for the release (info hash when present). */
  hash: string;
  traits: StreamTraits;
  hints: LanguageHints;
  score: number;
  verified: VerifiedSource | null;
  /** Why probing failed (link expired, not cached, engine offline…). */
  verifyError?: string;
}

/** Stable identifier for a Torrentio/Peerflix stream URL: the info hash when present, else a digest. */
export function sourceHash(streamUrl: string): string {
  const m = /([a-f0-9]{40})/i.exec(streamUrl);
  if (m) return m[1].toLowerCase();
  return crypto.createHash("sha256").update(streamUrl).digest("hex").slice(0, 32);
}

// --- Caches -----------------------------------------------------------------------------------
const LINK_TTL_MS = 3 * 60 * 60 * 1000;
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;
const linkCache = new Map<string, { url: string; at: number }>();
const probeCache = new Map<string, VerifiedSource>();
const probeInFlight = new Map<string, Promise<VerifiedSource>>();

export class NotCachedError extends Error {}

function isDebridCdn(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "real-debrid.com" || host.endsWith(".real-debrid.com");
  } catch {
    return false;
  }
}

/** Resolves (and caches) the direct Real-Debrid link for a release. Uncached torrents are rejected. */
export async function resolveDebridLink(streamUrl: string, token: string, season?: number, episode?: number, fresh = false): Promise<string> {
  const key = `${streamUrl}|${season ?? ""}|${episode ?? ""}`;
  const hit = linkCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < LINK_TTL_MS) return hit.url;
  const url = await resolveTorrentioStreamUrl(streamUrl, token, { season, episode });
  // Torrentio answers uncached torrents with its own "downloading…" placeholder video.
  if (!isDebridCdn(url)) throw new NotCachedError("This release is not cached on Real-Debrid yet.");
  linkCache.set(key, { url, at: Date.now() });
  if (linkCache.size > 2000) for (const [k, v] of linkCache) if (Date.now() - v.at > LINK_TTL_MS) linkCache.delete(k);
  return url;
}

export function fileNameFromUrl(u: string): string {
  try {
    return decodeURIComponent(path.posix.basename(new URL(u).pathname));
  } catch {
    return "video";
  }
}

/** Probes one release through the engine (cached for a day per release + episode). */
export async function probeCandidate(
  stream: StremioStream,
  opts: { token: string; owner: string; season?: number; episode?: number; title?: string }
): Promise<VerifiedSource> {
  const key = `${sourceHash(stream.url!)}|${opts.season ?? ""}|${opts.episode ?? ""}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.probedAt < PROBE_TTL_MS) return hit;
  const pending = probeInFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    let url = await resolveDebridLink(stream.url!, opts.token, opts.season, opts.episode);
    const probe = async (u: string) =>
      engineJson<{ probeMs: number; source: Record<string, unknown> }>("/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: mintTicket({ kind: "url", url: u, provider: "real-debrid", fileName: fileNameFromUrl(u), title: opts.title }, opts.owner) }),
        timeoutMs: 40_000,
      });
    let res;
    try {
      res = await probe(url);
    } catch (err) {
      const expired = err instanceof EngineRequestError && (err.status === 410 || err.code === "probe-not-found" || err.code === "probe-forbidden");
      if (!expired) throw err;
      url = await resolveDebridLink(stream.url!, opts.token, opts.season, opts.episode, true);
      res = await probe(url);
    }
    const s = res.source as {
      container: string; fileSize: number | null; durationSeconds: number | null; bitrateKbps: number | null;
      video: VerifiedSource["video"]; audio: VerifiedSource["audio"]; subtitles: VerifiedSource["subtitles"];
      audioLanguages: string[]; subtitleLanguages: string[]; untaggedAudioTracks: number;
    };
    const verified: VerifiedSource = {
      container: s.container, fileSize: s.fileSize, durationSeconds: s.durationSeconds, bitrateKbps: s.bitrateKbps,
      video: s.video, audio: s.audio ?? [], subtitles: s.subtitles ?? [],
      audioLanguages: s.audioLanguages ?? [], subtitleLanguages: s.subtitleLanguages ?? [],
      untaggedAudioTracks: s.untaggedAudioTracks ?? 0, probeMs: res.probeMs, probedAt: Date.now(),
    };
    probeCache.set(key, verified);
    if (probeCache.size > 2000) for (const [k, v] of probeCache) if (Date.now() - v.probedAt > PROBE_TTL_MS) probeCache.delete(k);
    return verified;
  })();
  probeInFlight.set(key, task);
  try {
    return await task;
  } finally {
    probeInFlight.delete(key);
  }
}

export function cachedVerification(stream: StremioStream, season?: number, episode?: number): VerifiedSource | null {
  const hit = probeCache.get(`${sourceHash(stream.url!)}|${season ?? ""}|${episode ?? ""}`);
  return hit && Date.now() - hit.probedAt < PROBE_TTL_MS ? hit : null;
}

export interface CandidateList {
  playable: StremioStream[];
  options: StremioStreamOption[];
  candidates: SourceCandidate[];
}

/**
 * Ranked releases for a title. Verified facts (when a release was probed before) outrank name hints.
 * Cheap: no network beyond the (cached) addon query.
 */
export async function listCandidates(request: PlayResolveRequest, prefs: RankingPreferences): Promise<CandidateList | null> {
  const listed = await fetchSortedTorrentStreams({ ...request, ranking: prefs });
  if (!listed) return null;
  const candidates: SourceCandidate[] = listed.playable.map((stream, index) => {
    const option = listed.options[index];
    const text = `${stream.name ?? ""} ${stream.title ?? ""}`;
    const verified = cachedVerification(stream, request.season, request.episode);
    return {
      index,
      label: option?.label ?? stream.title ?? "Release",
      detail: option?.detail ?? "",
      quality: option?.quality,
      cached: option?.cached ?? false,
      hash: sourceHash(stream.url!),
      traits: parseStreamTraits(text),
      hints: parseLanguageHints(text),
      score: candidateScore(text, prefs, verified),
      verified,
    };
  });
  // Re-rank with verified knowledge; keep `index` pointing at the playable list.
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return { ...listed, candidates };
}

export function describeProbeError(err: unknown): string {
  if (err instanceof NotCachedError) return "Not cached on Real-Debrid";
  if (err instanceof EngineUnavailableError) return "Media engine offline";
  if (err instanceof EngineRequestError) return err.message;
  return err instanceof Error ? err.message : "Could not check this release";
}
