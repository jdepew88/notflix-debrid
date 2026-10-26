import "server-only";
import {
  EngineRequestError,
  EngineUnavailableError,
  engineJson,
  mintTicket,
  type TicketSource,
} from "./media-engine/client";
import { registerSession } from "./media-engine/registry";
import { buildMediaItem, enrichPlayResolveRequest, type PlayResolveRequest } from "./play-resolve";
import { DebridError } from "./real-debrid-api";
import { debridProvider, enabledSourceAddons } from "./debrid";
import {
  NotCachedError,
  describeProbeError,
  fileNameFromUrl,
  listCandidates,
  probeCandidate,
  sourceHash,
  type CandidateList,
} from "./source-candidates";
import { candidateScore, type RankingPreferences } from "./source-ranking";
import { getProfilePreferences } from "./users";
import { orderedAudioLanguages, type ProfilePreferences } from "./profile-preferences";
import { registerStreamUrl, buildProxyStreamPath } from "./stream-sessions";
import type { ServerSettings } from "./server-settings";
import type { MediaItem } from "./types";
import { signMediaPath } from "./signed-url";

export interface ClientCapabilities {
  directVideo: string[];
  directAudio: string[];
  mseVideo: string[];
  mseAudio: string[];
  tenBit: string[];
  hdrDisplay?: boolean;
  mse?: boolean;
  nativeHls?: boolean;
  maxHeight?: number;
}

export interface StartPlaybackInput {
  userId: string;
  watchId: string;
  request: PlayResolveRequest;
  /** Real-Debrid account torrent id (debrid-… watch ids). */
  torrentId?: string;
  /** Explicit stream choice from the source picker (index into the ranked list). */
  streamIndex?: number;
  client: ClientCapabilities;
  startSeconds?: number;
  audioIndex?: number;
  subtitleIndex?: number;
  /** Active profile: its audio/subtitle preferences drive track and source selection. */
  profileId?: string;
  /** One-off resolution cap (Playback quality menu); defaults to the server setting. */
  maxResolution?: number;
}

export interface EngineSessionView {
  id: string;
  mode: string;
  modeLabel: string;
  output: "hls" | "progressive";
  generation: number;
  generationStart: number;
  durationSeconds: number | null;
  sourceStartTime: number;
  startupMs: number | null;
  probeMs: number;
  state: string;
  decision: Record<string, unknown>;
  tracks: {
    audio: Array<{ index: number; codec: string; language?: string; languageCode?: string | null; title?: string; channels?: number; default?: boolean }>;
    subtitles: Array<{ index: number; codec: string; language?: string; languageCode?: string | null; title?: string; forced?: boolean; default?: boolean; kind: string }>;
    selectedAudio: number | null;
    selectedSubtitle: number | null;
    selectedAudioLanguage?: string | null;
    audioLanguageMatched?: boolean | null;
    availableAudioLanguages?: string[];
  };
  source: Record<string, unknown>;
}

export interface StartPlaybackResult {
  ok: true;
  engine: "online" | "offline";
  session?: EngineSessionView;
  urls: { manifest?: string; stream?: string; cast?: string };
  /** Set when the engine is offline and the file is streamed as-is (may not play in every browser). */
  fallback?: { kind: "direct"; url: string; reason: string };
  item?: MediaItem;
  watchId: string;
  provider: "real-debrid";
  streamLabel?: string;
  quality?: string;
  candidateIndex?: number;
  /** Non-secret identifier of the chosen release (info hash). */
  sourceHash?: string;
  candidates?: number;
  /** Other releases already verified to carry a preferred audio language. */
  alternativesWithLanguage?: number;
  candidatesTried: number;
  defaultSubtitleIndex: number | null;
  /** Audio language outcome for the chosen file. */
  audio: { selectedLanguage: string | null; matched: boolean | null; available: string[]; preferred: string[] };
  timing: { resolveMs: number; linkMs: number; engineMs: number; totalMs: number; probeMs?: number };
  notices: string[];
}

export interface StartPlaybackFailure {
  ok: false;
  error: string;
  code: string;
  item?: MediaItem;
  details: string[];
}

/** Effective preferences for this request: profile prefs (with per-title memory) over server defaults. */
function resolvePreferences(input: StartPlaybackInput, settings: ServerSettings): ProfilePreferences {
  const prefs = getProfilePreferences(input.userId, input.profileId);
  const title = prefs.titlePrefs[input.watchId];
  return {
    ...prefs,
    audioLanguage: (prefs.rememberLanguage && title?.audioLanguage) || prefs.audioLanguage || settings.audioLanguage,
    subtitleLanguage: (prefs.rememberLanguage && title?.subtitleLanguage) || prefs.subtitleLanguage,
    subtitlesEnabled: prefs.rememberLanguage && title?.subtitleLanguage ? title.subtitleLanguage !== "off" : prefs.subtitlesEnabled,
    preferSurround: prefs.preferSurround || settings.surroundAudio,
  };
}

function enginePreferences(input: StartPlaybackInput, settings: ServerSettings, prefs: ProfilePreferences, item?: MediaItem) {
  return {
    maxHeight: input.maxResolution ?? settings.maxResolution,
    quality: settings.playbackQuality,
    // The engine owns the backend choice (owner setting + verified hardware); "auto" defers to it.
    hardwareAcceleration: settings.hardwareAcceleration === "off" ? "off" : "auto",
    allowDirectPlay: settings.directPlay !== false,
    surround: prefs.preferSurround,
    audioLanguage: prefs.audioLanguage,
    audioLanguages: orderedAudioLanguages(prefs),
    preferOriginalAudio: prefs.preferOriginalAudio,
    originalLanguage: item?.originalLanguage,
  };
}

/**
 * Staged probing: verify the top-ranked releases (bounded, in parallel, cached per release) and
 * reorder by verified audio languages. Stops early when the best-ranked release already carries the
 * preferred language. Releases that fail to verify stay in the order (they may still play).
 */
async function stageCandidates(
  listed: CandidateList,
  request: PlayResolveRequest,
  ranking: RankingPreferences,
  opts: { token: string; owner: string; title?: string },
  notices: string[]
): Promise<number[]> {
  const wanted = ranking.audioLanguages ?? [];
  const ranked = listed.candidates.map((c) => c.index);
  if (wanted.length === 0) return ranked.slice(0, 4);

  const top = listed.candidates.slice(0, 3);
  const hasWanted = (langs: string[]) => langs.some((l) => wanted.includes(l));
  // Already-verified best candidate with the language: nothing to probe.
  if (top[0]?.verified && hasWanted(top[0].verified.audioLanguages)) return ranked.slice(0, 4);

  const probes = top.map((c) => {
    if (c.verified) return Promise.resolve(c.verified);
    const stream = listed.playable[c.index];
    return probeCandidate(stream, { ...opts, season: request.season, episode: request.episode }).then(
      (v) => { c.verified = v; return v; },
      (err) => { c.verifyError = describeProbeError(err); return null; }
    );
  });
  // Early exit: the first candidate verified with the wanted language wins.
  try {
    const first = await probes[0];
    if (first && hasWanted(first.audioLanguages)) return ranked.slice(0, 4);
  } catch { /* handled below */ }
  await Promise.all(probes);

  const text = (i: number) => `${listed.playable[i].name ?? ""} ${listed.playable[i].title ?? ""}`;
  const rescored = listed.candidates
    .map((c) => ({ i: c.index, score: candidateScore(text(c.index), ranking, c.verified), c }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  // Keep verified-but-unavailable releases out of the way when alternatives exist.
  const usable = rescored.filter((r) => !(r.c.verifyError && /not cached|expired|not available/i.test(r.c.verifyError)));
  const order = (usable.length ? usable : rescored).map((r) => r.i);
  const verifiedWithLang = listed.candidates.filter((c) => c.verified && hasWanted(c.verified.audioLanguages));
  if (verifiedWithLang.length === 0 && listed.candidates.some((c) => c.verified)) {
    notices.push("None of the checked releases carries your preferred audio language.");
  }
  return order.slice(0, 4);
}

async function createEngineSession(
  input: StartPlaybackInput,
  settings: ServerSettings,
  prefs: ProfilePreferences,
  item: MediaItem | undefined,
  source: TicketSource
): Promise<EngineSessionView & { token: string }> {
  const ticket = mintTicket(source, input.userId);
  return engineJson<EngineSessionView & { token: string }>("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ticket,
      client: input.client,
      preferences: enginePreferences(input, settings, prefs, item),
      audioIndex: input.audioIndex,
      subtitleIndex: input.subtitleIndex,
      startSeconds: Math.max(0, input.startSeconds ?? 0),
    }),
    // Probe + first segment of a 4K HDR transcode can take several seconds.
    timeoutMs: 90_000,
  });
}

function pickDefaultSubtitle(session: EngineSessionView, prefs: ProfilePreferences, audioMatched: boolean | null): number | null {
  const lang = prefs.subtitleLanguage.toLowerCase();
  const text = session.tracks.subtitles.filter((s) => s.kind === "text");
  const inLang = text.filter((s) => (s.languageCode ?? s.language?.slice(0, 2).toLowerCase()) === lang);
  if (lang === "off") return null;
  if (prefs.subtitlesEnabled) {
    return (inLang.find((s) => !s.forced) ?? inLang[0])?.index ?? null;
  }
  // Subtitles off: still show forced (foreign-parts) subtitles in the viewer's language when the
  // audio is in that language, which is what forced tracks are for.
  if (prefs.forcedSubtitles && audioMatched !== false) {
    return inLang.find((s) => s.forced)?.index ?? null;
  }
  return null;
}

async function finish(
  input: StartPlaybackInput,
  settings: ServerSettings,
  prefs: ProfilePreferences,
  created: EngineSessionView & { token: string },
  meta: {
    provider: StartPlaybackResult["provider"];
    item?: MediaItem;
    streamLabel?: string;
    quality?: string;
    candidateIndex?: number;
    sourceHash?: string;
    candidates?: number;
    alternativesWithLanguage?: number;
    tried: number;
    timing: StartPlaybackResult["timing"];
    notices: string[];
  }
): Promise<StartPlaybackResult> {
  const { token, ...session } = created;
  registerSession({
    id: session.id,
    token,
    owner: input.userId,
    title: meta.item?.title,
    provider: meta.provider,
    sourceKey: meta.sourceHash ?? "",
  });
  const matched = session.tracks.audioLanguageMatched ?? null;
  if (matched === false) {
    meta.notices.push(
      meta.alternativesWithLanguage
        ? "This release has no audio in your preferred language. Other releases do — use Change video source."
        : "This release has no audio in your preferred language."
    );
  }
  const base = `/api/playback/${session.id}`;
  const primary = session.output === "hls" ? `${base}/manifest?generation=${session.generation}` : `${base}/stream`;
  return {
    ok: true,
    engine: "online",
    session,
    urls: {
      manifest: session.output === "hls" ? primary : undefined,
      stream: session.output === "progressive" ? primary : undefined,
      cast: await signMediaPath(primary, 6 * 60 * 60, input.userId),
    },
    item: meta.item,
    watchId: input.watchId,
    provider: meta.provider,
    streamLabel: meta.streamLabel,
    quality: meta.quality,
    candidateIndex: meta.candidateIndex,
    sourceHash: meta.sourceHash,
    candidates: meta.candidates,
    alternativesWithLanguage: meta.alternativesWithLanguage,
    candidatesTried: meta.tried,
    defaultSubtitleIndex: input.subtitleIndex ?? pickDefaultSubtitle(session, prefs, matched),
    audio: {
      selectedLanguage: session.tracks.selectedAudioLanguage ?? null,
      matched,
      available: session.tracks.availableAudioLanguages ?? [],
      preferred: orderedAudioLanguages(prefs),
    },
    timing: meta.timing,
    notices: meta.notices,
  };
}

function engineOfflineFallback(
  input: StartPlaybackInput,
  meta: { provider: StartPlaybackResult["provider"]; item?: MediaItem; streamLabel?: string; quality?: string },
  directUrl: string,
  timing: StartPlaybackResult["timing"]
): StartPlaybackResult {
  return {
    ok: true,
    engine: "offline",
    urls: { stream: directUrl },
    fallback: {
      kind: "direct",
      url: directUrl,
      reason: "The media engine is offline, so only files your browser can play natively will work.",
    },
    item: meta.item,
    watchId: input.watchId,
    provider: meta.provider,
    streamLabel: meta.streamLabel,
    quality: meta.quality,
    candidatesTried: 1,
    defaultSubtitleIndex: null,
    audio: { selectedLanguage: null, matched: null, available: [], preferred: [] },
    timing,
    notices: [],
  };
}

function describe(err: unknown): { message: string; code: string; retryNext: boolean; expired: boolean } {
  if (err instanceof EngineRequestError) {
    const expired = err.status === 410 || err.code === "probe-not-found" || err.code === "probe-forbidden";
    return { message: err.message, code: err.code ?? `engine-${err.status}`, retryNext: err.code !== "busy", expired };
  }
  if (err instanceof EngineUnavailableError) return { message: err.message, code: `engine-${err.reason}`, retryNext: false, expired: false };
  if (err instanceof NotCachedError) return { message: err.message, code: "debrid-not-cached", retryNext: true, expired: false };
  if (err instanceof DebridError) return { message: err.message, code: `debrid-${err.kind}`, retryNext: err.kind !== "auth" && err.kind !== "premium", expired: err.kind === "unavailable" };
  return { message: err instanceof Error ? err.message : "Playback failed", code: "error", retryNext: true, expired: false };
}

export async function startPlayback(
  input: StartPlaybackInput,
  settings: ServerSettings
): Promise<StartPlaybackResult | StartPlaybackFailure> {
  const started = Date.now();
  const details: string[] = [];
  const notices: string[] = [];
  const timing: StartPlaybackResult["timing"] = { resolveMs: 0, linkMs: 0, engineMs: 0, totalMs: 0 };
  const provider = debridProvider();
  const prefs = resolvePreferences(input, settings);
  const ranking: RankingPreferences = {
    maxResolution: input.maxResolution ?? settings.maxResolution,
    quality: settings.playbackQuality,
    hevcSupported: input.client.mseVideo.includes("hevc"),
    audioLanguages: orderedAudioLanguages(prefs),
  };
  const request: PlayResolveRequest = {
    ...input.request,
    sourceAddons: enabledSourceAddons(),
    tmdbApiKey: settings.tmdbApiKey || undefined,
  };
  let item: MediaItem | undefined;
  let engineDown = false;

  if (!provider.isConfigured()) {
    return {
      ok: false,
      error: `Connect ${provider.displayName} in Settings to play titles.`,
      code: "debrid-not-configured",
      details,
    };
  }

  // A torrent already in the user's debrid account (Browse → My downloads).
  if (input.torrentId) {
    try {
      const t0 = Date.now();
      const stream = await provider.resolveAccountTorrent(input.torrentId, { season: request.season, episode: request.episode });
      timing.linkMs = Date.now() - t0;
      item = { id: input.watchId, title: stream.filename, type: "movie", source: "debrid" };
      const t1 = Date.now();
      const created = await createEngineSession(input, settings, prefs, item, {
        kind: "url", url: stream.streamUrl, provider: "real-debrid", fileName: stream.filename, title: stream.filename,
      });
      timing.engineMs = Date.now() - t1;
      timing.totalMs = Date.now() - started;
      return finish(input, settings, prefs, created, { provider: "real-debrid", item, streamLabel: stream.filename, tried: 1, timing, notices });
    } catch (err) {
      const d = describe(err);
      if (err instanceof EngineUnavailableError) {
        timing.totalMs = Date.now() - started;
        const stream = await provider.resolveAccountTorrent(input.torrentId, { season: request.season, episode: request.episode }).catch(() => null);
        if (stream) return engineOfflineFallback(input, { provider: "real-debrid", item }, buildProxyStreamPath(registerStreamUrl(stream.streamUrl)), timing);
      }
      return { ok: false, error: d.message, code: d.code, item, details: [d.message] };
    }
  }

  if (!request.sourceAddons?.length) {
    return {
      ok: false,
      error: "No release search source is enabled. Enable one in Settings → Real-Debrid.",
      code: "no-source-addon",
      details,
    };
  }

  const enriched = await enrichPlayResolveRequest(request);
  const t0 = Date.now();
  let listed: Awaited<ReturnType<typeof listCandidates>> = null;
  try {
    listed = await listCandidates(enriched, ranking);
  } catch (err) {
    details.push(`Source search failed: ${err instanceof Error ? err.message : err}`);
  }
  timing.resolveMs += Date.now() - t0;
  item ??= await buildMediaItem(enriched);
  if (!listed || listed.playable.length === 0) {
    details.push(enriched.tmdbId ? `No ${provider.displayName} sources found for this title.` : "Could not identify the title for a source search.");
  } else {
    // Candidate order: an explicit pick, else the ranked list refined by probing the top few so
    // the chosen release actually carries the preferred audio language.
    let order: number[];
    if (input.streamIndex != null) {
      order = [input.streamIndex];
    } else {
      const t1 = Date.now();
      order = await stageCandidates(listed, enriched, ranking, { token: settings.realDebridToken, owner: input.userId, title: item?.title }, notices);
      timing.probeMs = Date.now() - t1;
    }

    let tried = 0;
    for (const index of order) {
      const stream = listed.playable[index];
      const option = listed.options[index];
      if (!stream?.url) continue;
      tried++;
      try {
        const t1 = Date.now();
        let url = await provider.resolveReleaseLink(stream.url, { season: enriched.season, episode: enriched.episode });
        timing.linkMs += Date.now() - t1;
        const t2 = Date.now();
        const ticketSource = (u: string): TicketSource => ({
          kind: "url", url: u, provider: "real-debrid", fileName: fileNameFromUrl(u), title: item?.title,
        });
        let created;
        try {
          created = await createEngineSession(input, settings, prefs, item, ticketSource(url));
        } catch (err) {
          // An expired/removed link: unrestrict again once, then give up on this release.
          if (!describe(err).expired) throw err;
          url = await provider.resolveReleaseLink(stream.url, { season: enriched.season, episode: enriched.episode, fresh: true });
          created = await createEngineSession(input, settings, prefs, item, ticketSource(url));
        }
        timing.engineMs += Date.now() - t2;
        timing.totalMs = Date.now() - started;
        if (tried > 1) notices.push(`Picked an alternate release after ${tried - 1} unavailable source(s).`);
        const withLanguage = listed.candidates.filter((c) => c.verified && c.verified.audioLanguages.some((l) => ranking.audioLanguages?.includes(l))).length;
        return finish(input, settings, prefs, created, {
          provider: "real-debrid", item, streamLabel: option?.label, quality: option?.quality,
          candidateIndex: index, sourceHash: sourceHash(stream.url), candidates: listed.playable.length,
          alternativesWithLanguage: withLanguage, tried, timing, notices,
        });
      } catch (err) {
        const d = describe(err);
        details.push(`${option?.label ?? `Source ${index + 1}`}: ${d.message}`);
        if (err instanceof EngineUnavailableError) {
          engineDown = true;
          try {
            const url = await provider.resolveReleaseLink(stream.url, { season: enriched.season, episode: enriched.episode });
            timing.totalMs = Date.now() - started;
            return engineOfflineFallback(input, { provider: "real-debrid", item, streamLabel: option?.label, quality: option?.quality },
              buildProxyStreamPath(registerStreamUrl(url)), timing);
          } catch {
            break;
          }
        }
        if (!d.retryNext) break;
      }
    }
  }

  return {
    ok: false,
    error: engineDown
      ? "The media engine is offline. Restart Notflix from the launcher (Start-Notflix)."
      : details.find((d) => !/not configured/i.test(d)) ?? details[0] ?? "No playable source was found for this title.",
    code: engineDown ? "engine-offline" : "no-source",
    item,
    details,
  };
}
