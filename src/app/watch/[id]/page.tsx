"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { EpisodePicker } from "@/components/player/EpisodePicker";
import { SourceSelector, type SourceCandidateView } from "@/components/player/SourceSelector";
import { useAppStore, getMediaProgress, useActivePreferences } from "@/lib/store";
import type { SubtitleStyle } from "@/lib/profile-preferences";
import { posterUrl } from "@/lib/tmdb";
import { hasRealDebrid, type MediaItem } from "@/lib/types";
import type { StreamTrack } from "@/types/media-tracks";
import { formatEpisodeLabel } from "@/lib/episode-parse";
import type { SeasonGroup } from "@/lib/episode-library";
import {
  getNextEpisode,
  hasSeasonEpisode,
  parseWatchTmdbId,
  resolveWatchMediaType,
} from "@/lib/episode-nav";
import { resolveProgressKey, type WatchedItemMeta } from "@/lib/watch-progress";
import {
  detectClientCapabilities,
  trackLabel,
  type EngineTrack,
  type StartPlaybackResponse,
} from "@/lib/playback-client";
import { useEngineSession } from "@/hooks/useEngineSession";

function toStreamTrack(t: EngineTrack, type: "audio" | "subtitle"): StreamTrack {
  return {
    index: t.index,
    type,
    codec: t.codec,
    language: t.language,
    title: t.title,
    default: t.default,
    forced: t.forced,
    channels: t.channels,
    label: trackLabel(t, type),
  };
}

type Phase =
  | { kind: "starting" }
  | { kind: "episodes" }
  | { kind: "playing" }
  | { kind: "error"; message: string; details: string[]; code?: string };

export default function WatchPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = decodeURIComponent(params.id as string);
  const queryKey = searchParams.toString();
  const updateProgress = useAppStore((s) => s.updateProgress);
  const storeSettings = useAppStore((s) => s.settings);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const prefs = useActivePreferences();
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const rememberTitlePreference = useAppStore((s) => s.rememberTitlePreference);
  const lastWatchedForProfile = useAppStore((s) =>
    s.activeProfileId ? s.lastWatchedByProfile[s.activeProfileId] : undefined
  );

  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [item, setItem] = useState<MediaItem | null>(null);
  const [result, setResult] = useState<StartPlaybackResponse | null>(null);
  const [subtitleIndex, setSubtitleIndex] = useState<number | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [qualityCap, setQualityCap] = useState<number | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  /** Current movie-time position, for switching sources without losing the place. */
  const positionRef = useRef(0);
  const [episodePickerShow, setEpisodePickerShow] = useState<{
    title: string;
    tmdbId?: number;
    seriesId: string;
    poster?: string;
    overlay?: boolean;
  } | null>(null);
  const [seriesSeasons, setSeriesSeasons] = useState<SeasonGroup[]>([]);
  const resumeSeekPendingRef = useRef<number | null>(null);
  const startRequestRef = useRef(0);

  const watchMediaType = resolveWatchMediaType(searchParams.get("type"), id);
  const watchSeason = searchParams.get("season") ? parseInt(searchParams.get("season")!, 10) : undefined;
  const watchEpisode = searchParams.get("episode") ? parseInt(searchParams.get("episode")!, 10) : undefined;
  const watchTmdbId = parseWatchTmdbId(id, searchParams);
  const inSeriesPlayback = watchMediaType === "series" && hasSeasonEpisode(watchSeason, watchEpisode);
  const seriesWatchId = id;
  const progressKey =
    inSeriesPlayback && watchSeason != null && watchEpisode != null
      ? resolveProgressKey({ watchId: seriesWatchId, season: watchSeason, episode: watchEpisode })
      : id;

  const engine = useEngineSession(result?.session ?? null);

  // Navigating to another title/episode resets playback state before the load effect runs.
  const navKey = `${id}?${queryKey}`;
  const [activeNavKey, setActiveNavKey] = useState(navKey);
  if (activeNavKey !== navKey) {
    setActiveNavKey(navKey);
    setResult(null);
    setItem(null);
    setEpisodePickerShow(null);
    setPhase({ kind: "starting" });
  }

  /** Resume point: exact seconds when known, else percentage × duration once it is known. */
  const resumePlan = useCallback(() => {
    const percent = getMediaProgress(progressKey);
    const entry = lastWatchedForProfile?.[inSeriesPlayback ? seriesWatchId : id];
    const sameEpisode = !inSeriesPlayback || (entry?.season === watchSeason && entry?.episode === watchEpisode);
    if (percent <= 0 || percent >= 95) return { seconds: 0, percent: 0 };
    if (sameEpisode && entry?.positionSeconds && entry.positionSeconds > 5) return { seconds: entry.positionSeconds, percent };
    if (sameEpisode && entry?.durationSeconds) return { seconds: (percent / 100) * entry.durationSeconds, percent };
    return { seconds: 0, percent };
  }, [progressKey, lastWatchedForProfile, inSeriesPlayback, seriesWatchId, id, watchSeason, watchEpisode]);

  const startPlayback = useCallback(
    async (
      opts: {
        streamIndex?: number;
        known?: MediaItem | null;
        /** Replace the current stream in place (keeps it until the new one is ready). */
        switching?: boolean;
        maxResolution?: number | null;
      } = {}
    ): Promise<boolean> => {
      const requestId = ++startRequestRef.current;
      if (!opts.switching) setPhase({ kind: "starting" });
      const plan = opts.switching ? { seconds: positionRef.current, percent: 0 } : resumePlan();
      resumeSeekPendingRef.current = plan.seconds > 0 ? null : plan.percent > 0 ? plan.percent : null;
      const known = opts.known ?? item;
      const body = {
        watchId: id,
        tmdbId: known?.tmdbId ?? watchTmdbId,
        type: watchMediaType,
        season: watchSeason,
        episode: watchEpisode,
        title: searchParams.get("title") ?? known?.title ?? undefined,
        year: known?.releaseDate ? parseInt(known.releaseDate.slice(0, 4), 10) || undefined : undefined,
        seriesId: searchParams.get("seriesId") ?? (inSeriesPlayback ? seriesWatchId : undefined),
        torrentId: id.startsWith("debrid-") ? id.slice("debrid-".length) : undefined,
        streamIndex: opts.streamIndex,
        client: detectClientCapabilities(),
        startSeconds: plan.seconds,
        profileId: activeProfileId ?? undefined,
        maxResolution: (opts.maxResolution === undefined ? qualityCap : opts.maxResolution) ?? undefined,
      };
      try {
        const res = await fetch("/api/playback/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as StartPlaybackResponse;
        if (requestId !== startRequestRef.current) {
          // Superseded, or the viewer already left: close the session this request opened.
          if (data.ok && data.session?.id) void fetch(`/api/playback/${data.session.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
          return false;
        }
        if (data.item) setItem((prev) => ({ ...(prev ?? {}), ...data.item! }) as MediaItem);
        if (!res.ok || !data.ok) {
          // While switching, the current stream keeps playing; only report the failure.
          if (!opts.switching) {
            setPhase({ kind: "error", message: data.error || "This title couldn't be played.", details: data.details ?? [], code: data.code });
          }
          return false;
        }
        setResult(data);
        setSubtitleIndex(data.defaultSubtitleIndex ?? null);
        setPhase({ kind: "playing" });
        if (data.sourceHash) rememberTitlePreference(id, { sourceHash: data.sourceHash });
        return true;
      } catch {
        if (requestId !== startRequestRef.current) return false;
        if (!opts.switching) setPhase({ kind: "error", message: "Couldn't reach the server.", details: [] });
        return false;
      }
    },
    [id, item, watchTmdbId, watchMediaType, watchSeason, watchEpisode, searchParams, inSeriesPlayback, seriesWatchId, resumePlan, activeProfileId, qualityCap, rememberTitlePreference]
  );

  // Leaving the page makes any start request still in flight stale (its session is then closed on arrival).
  useEffect(() => () => {
    startRequestRef.current++;
  }, []);

  /** Change Video Source: the current stream stays up until the replacement is ready. */
  const switchSource = useCallback(
    async (candidate: SourceCandidateView) => {
      setSwitchNotice(null);
      const ok = await startPlayback({ streamIndex: candidate.index, switching: true });
      if (ok) {
        setSourceOpen(false);
        setSwitchNotice(`Switched to: ${candidate.label}`);
        window.setTimeout(() => setSwitchNotice(null), 4000);
      }
      return ok;
    },
    [startPlayback]
  );

  const changeQuality = useCallback(
    async (height: number | null) => {
      setQualityCap(height);
      await startPlayback({ switching: true, maxResolution: height });
    },
    [startPlayback]
  );

  // Load: episode picker for shows without an episode, otherwise start playback straight away.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (watchMediaType === "series" && !hasSeasonEpisode(watchSeason, watchEpisode)) {
        setEpisodePickerShow({
          title: searchParams.get("title") ?? "TV Show",
          tmdbId: watchTmdbId,
          seriesId: id,
          poster: posterUrl(undefined, "w500"),
        });
        setPhase({ kind: "episodes" });
        return;
      }
      if (!cancelled) await startPlayback({ known: null });
    }

    void load();
    return () => {
      cancelled = true;
    };
    // queryKey covers season/episode/title changes; startPlayback is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, queryKey]);

  // Legacy progress entries only store a percentage: once the duration is known, jump there once.
  const engineSession = engine.state?.session;
  useEffect(() => {
    const pct = resumeSeekPendingRef.current;
    const duration = engineSession?.durationSeconds;
    if (pct == null || !duration || !engineSession) return;
    resumeSeekPendingRef.current = null;
    void engine.seek((pct / 100) * duration);
    // Only when a new session arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineSession?.id]);

  // Episode list for next-episode / episode overlay.
  useEffect(() => {
    if (!inSeriesPlayback) return;
    let cancelled = false;
    const p = new URLSearchParams();
    if (watchTmdbId) p.set("tmdbId", String(watchTmdbId));
    p.set("seriesId", seriesWatchId);
    p.set("title", item?.title ?? searchParams.get("title") ?? "TV Show");
    void fetch(`/api/play/episodes?${p}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.seasons) setSeriesSeasons(data.seasons as SeasonGroup[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [inSeriesPlayback, watchTmdbId, seriesWatchId, item?.title, searchParams]);

  const navigateToEpisode = useCallback(
    (season: number, episode: number, watchId?: string) => {
      const p = new URLSearchParams(searchParams.toString());
      p.set("type", "series");
      p.set("season", String(season));
      p.set("episode", String(episode));
      const showTitle = episodePickerShow?.title ?? searchParams.get("title") ?? item?.title;
      if (watchTmdbId) p.set("tmdbId", String(watchTmdbId));
      if (showTitle) p.set("title", showTitle);
      setEpisodePickerShow(null);
      router.replace(`/watch/${encodeURIComponent(watchId ?? id)}?${p.toString()}`);
    },
    [searchParams, episodePickerShow?.title, watchTmdbId, item?.title, id, router]
  );

  const nextEpisode =
    inSeriesPlayback && watchSeason != null && watchEpisode != null
      ? getNextEpisode(inSeriesPlayback ? seriesSeasons : [], watchSeason, watchEpisode)
      : null;
  const handleNextEpisode = useCallback(() => {
    if (nextEpisode) navigateToEpisode(nextEpisode.season, nextEpisode.episode);
  }, [nextEpisode, navigateToEpisode]);

  const handleOpenEpisodeList = useCallback(() => {
    setEpisodePickerShow({
      title: searchParams.get("title") ?? item?.title ?? "TV Show",
      tmdbId: watchTmdbId,
      seriesId: seriesWatchId,
      poster: posterUrl(item?.posterPath, "w500"),
      overlay: true,
    });
  }, [searchParams, item, watchTmdbId, seriesWatchId]);

  const sourceQuery = useMemo(
    () => ({
      tmdbId: item?.tmdbId ?? watchTmdbId,
      type: watchMediaType,
      season: watchSeason,
      episode: watchEpisode,
      seriesId: searchParams.get("seriesId") ?? undefined,
      title: searchParams.get("title") ?? item?.title,
    }),
    [item, watchTmdbId, watchMediaType, watchSeason, watchEpisode, searchParams]
  );

  const session = engine.state?.session ?? null;
  const tracks = session?.tracks;
  const audioTracks = useMemo(() => (tracks?.audio ?? []).map((t) => toStreamTrack(t, "audio")), [tracks]);
  const subtitleTracks = useMemo(() => (tracks?.subtitles ?? []).map((t) => toStreamTrack(t, "subtitle")), [tracks]);
  const selectedAudio = tracks?.selectedAudio ?? audioTracks[0]?.index ?? 0;

  const handleAudioChange = useCallback(
    (index: number) => {
      const burned = session?.decision && (session.tracks.selectedSubtitle ?? null);
      void engine.changeTracks(index, typeof burned === "number" ? burned : null);
      const code = session?.tracks.audio.find((t) => t.index === index)?.languageCode;
      if (code) rememberTitlePreference(id, { audioLanguage: code });
    },
    [engine, session, rememberTitlePreference, id]
  );

  const handleSubtitleChange = useCallback(
    (index: number | null) => {
      const track = tracks?.subtitles.find((t) => t.index === index);
      const currentlyBurned = tracks?.selectedSubtitle ?? null;
      setSubtitleIndex(index);
      rememberTitlePreference(id, { subtitleLanguage: index == null ? "off" : track?.languageCode ?? undefined });
      // Image subtitles (PGS/VobSub) are drawn into the picture by the engine; text ones are a sidecar.
      if (track?.kind === "image") {
        void engine.changeTracks(selectedAudio, index);
      } else if (currentlyBurned != null) {
        void engine.changeTracks(selectedAudio, null);
      }
    },
    [engine, tracks, selectedAudio, rememberTitlePreference, id]
  );

  const sidecar = useMemo(() => {
    if (!session || subtitleIndex == null) return null;
    const track = session.tracks.subtitles.find((t) => t.index === subtitleIndex);
    if (!track || track.kind !== "text") return null;
    return { url: `/api/playback/${session.id}/subtitles/${subtitleIndex}`, sourceStartTime: session.sourceStartTime };
  }, [session, subtitleIndex]);

  const itemMeta = useMemo<WatchedItemMeta | undefined>(() => {
    if (!item) return undefined;
    return {
      id: inSeriesPlayback ? seriesWatchId : id,
      title: searchParams.get("title") ?? item.title,
      type: inSeriesPlayback ? "series" : item.type === "episode" ? "series" : (item.type as "movie" | "series"),
      tmdbId: item.tmdbId ?? watchTmdbId,
      mediaType: watchMediaType === "series" ? "tv" : "movie",
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      releaseDate: item.releaseDate,
    };
  }, [item, inSeriesPlayback, seriesWatchId, id, searchParams, watchTmdbId, watchMediaType]);

  const handleProgress = useCallback(
    (seconds: number, percent: number) => {
      positionRef.current = seconds;
      const duration = session?.durationSeconds ?? undefined;
      const meta = { item: itemMeta, positionSeconds: Math.round(seconds), durationSeconds: duration ?? undefined };
      if (inSeriesPlayback && watchSeason != null && watchEpisode != null) {
        updateProgress(progressKey, percent, { ...meta, season: watchSeason, episode: watchEpisode, seriesId: seriesWatchId });
        return;
      }
      updateProgress(id, percent, meta);
    },
    [id, progressKey, inSeriesPlayback, watchSeason, watchEpisode, seriesWatchId, updateProgress, itemMeta, session?.durationSeconds]
  );

  const settings = storeSettings;
  const canPickSource = hasRealDebrid(settings) && Boolean(item?.tmdbId ?? watchTmdbId ?? searchParams.get("title"));

  if (phase.kind === "episodes" && episodePickerShow && !episodePickerShow.overlay) {
    return (
      <EpisodePicker
        title={episodePickerShow.title}
        poster={episodePickerShow.poster}
        tmdbId={episodePickerShow.tmdbId}
        seriesId={episodePickerShow.seriesId}
        onSelect={navigateToEpisode}
        onCancel={() => router.back()}
      />
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="relative flex h-screen flex-col items-center justify-center bg-black px-4 text-center" data-testid="playback-error">
        {sourceOpen && canPickSource && (
          <SourceSelector
            title={item?.title ?? searchParams.get("title") ?? "Choose a source"}
            query={sourceQuery}
            profileId={activeProfileId}
            client={detectClientCapabilities()}
            onSelect={async (c) => {
              const ok = await startPlayback({ streamIndex: c.index });
              if (ok) setSourceOpen(false);
              return ok;
            }}
            onClose={() => setSourceOpen(false)}
          />
        )}
        <p className="mb-2 text-xl font-semibold">{phase.message}</p>
        {phase.code === "engine-offline" && (
          <p className="mb-4 max-w-md text-sm text-netflix-light-gray">
            Notflix&apos;s media engine converts files for your browser. Start it on the Windows host and try again.
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={() => void startPlayback()} className="rounded bg-white px-6 py-2 font-semibold text-black hover:bg-white/80">
            Try again
          </button>
          {canPickSource && (
            <button type="button" onClick={() => setSourceOpen(true)} className="rounded border border-white/40 px-6 py-2 hover:bg-white/10">
              Choose a source
            </button>
          )}
          <button type="button" onClick={() => router.back()} className="rounded border border-white/40 px-6 py-2 hover:bg-white/10">
            Go back
          </button>
        </div>
        {phase.details.length > 0 && (
          <details className="mt-6 max-w-xl text-left text-xs text-netflix-gray">
            <summary className="cursor-pointer text-center text-netflix-light-gray">Technical details</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {phase.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </details>
        )}
        {settings.realDebridConfigured === false && (
          <a href="/settings" className="mt-6 text-sm text-netflix-light-gray underline">
            Open Settings
          </a>
        )}
      </div>
    );
  }

  const src = engine.state?.src ?? result?.fallback?.url ?? null;
  if (phase.kind === "starting" || !src || !result) {
    return (
      <div className="flex h-screen items-center justify-center bg-black" data-testid="playback-starting">
        <button
          type="button"
          onClick={() => router.back()}
          className="absolute left-4 top-4 flex items-center gap-2 rounded bg-black/50 px-3 py-2 hover:bg-black/80"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="h-14 w-14 animate-spin rounded-full border-4 border-white/20 border-t-netflix-red" />
      </div>
    );
  }

  const title = item?.title ?? searchParams.get("title") ?? "Now playing";
  const playerTitle =
    inSeriesPlayback && watchSeason != null && watchEpisode != null
      ? `${searchParams.get("title") ?? title} · ${formatEpisodeLabel(watchSeason, watchEpisode)}`
      : title;

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <button
        type="button"
        onClick={() => router.back()}
        className="absolute left-4 top-4 z-50 flex items-center gap-2 rounded bg-black/50 px-3 py-2 hover:bg-black/80"
        aria-label="Back to browse"
      >
        <ArrowLeft className="h-5 w-5" />
        <span className="hidden text-sm font-medium sm:inline">Back</span>
      </button>
      {engine.error && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded bg-black/80 px-4 py-2 text-sm text-yellow-200">
          {engine.error}
        </div>
      )}
      <VideoPlayer
        key={`${id}-s${watchSeason ?? 0}-e${watchEpisode ?? 0}-${session?.id ?? "direct"}`}
        src={src}
        title={playerTitle}
        poster={posterUrl(item?.backdropPath ?? item?.posterPath, "w780")}
        initialProgress={0}
        resumeAt={session?.output === "progressive" || !session ? resumePlan().seconds : undefined}
        onProgress={handleProgress}
        autoAdvanceNext={Boolean(nextEpisode) && prefs.autoplayNextEpisode}
        onNextEpisode={nextEpisode ? handleNextEpisode : undefined}
        audioTracks={audioTracks}
        subtitleTracks={subtitleTracks}
        audioIndex={selectedAudio}
        subtitleIndex={subtitleIndex}
        onSubtitleChange={handleSubtitleChange}
        onAudioChange={audioTracks.length > 1 ? handleAudioChange : undefined}
        isDirectPlay={session?.mode === "DirectPlay"}
        qualityHint={result.quality ?? (session ? `${session.decision.height}p` : null)}
        trackSwitching={engine.busy}
        timeline={session ? { offset: engine.state!.offset, duration: session.durationSeconds } : undefined}
        onSeekRequest={session?.output === "hls" ? engine.seek : undefined}
        onPositionReport={engine.reportPosition}
        sidecarSubtitle={sidecar}
        bufferProfile={settings.bufferProfile ?? "auto"}
        notice={result.fallback?.reason ?? switchNotice ?? (result.audio?.matched === false ? result.notices?.find((n) => n.includes("preferred audio")) ?? null : null)}
        castSrc={result.urls?.cast}
        onChangeSource={canPickSource ? () => setSourceOpen(true) : undefined}
        quality={{ current: qualityCap, options: [2160, 1440, 1080, 720], onChange: (h) => void changeQuality(h) }}
        subtitleStyle={prefs.subtitleStyle}
        onSubtitleStyleChange={(style: SubtitleStyle) => updatePreferences({ subtitleStyle: style })}
        subtitleOffsetMs={prefs.subtitleOffsetMs}
        onSubtitleOffsetChange={(ms) => updatePreferences({ subtitleOffsetMs: ms })}
        forcedSubtitles={prefs.forcedSubtitles}
        onForcedSubtitlesChange={(v) => updatePreferences({ forcedSubtitles: v })}
        diagnostics={
          settings.streamDiagnostics === false
            ? undefined
            : {
                title: playerTitle,
                session,
                provider: result.provider,
                streamLabel: result.streamLabel ?? null,
                quality: result.quality ?? null,
                server: result.timing ?? null,
                fallbackReason: result.fallback?.reason ?? null,
                notices: result.notices,
              }
        }
        seriesPlayback={
          inSeriesPlayback && watchSeason != null && watchEpisode != null
            ? {
                season: watchSeason,
                episode: watchEpisode,
                hasNextEpisode: Boolean(nextEpisode),
                onNextEpisode: nextEpisode ? handleNextEpisode : undefined,
                onOpenEpisodes: handleOpenEpisodeList,
              }
            : undefined
        }
      />

      {sourceOpen && canPickSource && (
        <SourceSelector
          title={playerTitle}
          query={sourceQuery}
          profileId={activeProfileId}
          client={detectClientCapabilities()}
          currentHash={result.sourceHash ?? null}
          onSelect={switchSource}
          onClose={() => setSourceOpen(false)}
        />
      )}

      {episodePickerShow?.overlay && (
        <EpisodePicker
          title={episodePickerShow.title}
          poster={episodePickerShow.poster}
          tmdbId={episodePickerShow.tmdbId}
          seriesId={episodePickerShow.seriesId}
          currentSeason={watchSeason}
          currentEpisode={watchEpisode}
          overlay
          onSelect={navigateToEpisode}
          onCancel={() => setEpisodePickerShow(null)}
        />
      )}
    </div>
  );
}
