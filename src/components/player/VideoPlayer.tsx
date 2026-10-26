"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  Cast,
  Airplay,
  Subtitles,
  Gauge,
  ListVideo,
  ChevronRight,
  Download,
  Info,
  Activity,
  Copy,
  Flag,
  Layers,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useCast } from "@/hooks/useCast";
import {
  buildRemotePlaybackUrl,
  isHlsSource,
  isSafariBrowser,
} from "@/lib/cast-media";
import {
  applyHlsBufferTier,
  buildHlsConfig,
  getBufferedAhead,
  getMinPlayBufferSeconds,
  playWhenBuffered,
  qualityTierFromHeight,
  qualityTierFromHint,
  type BufferTier,
} from "@/lib/playback-buffer";
import { subtitleFileToObjectUrl } from "@/lib/external-subtitles";
import { TrackSelector } from "./TrackSelector";
import { StreamInfoModal } from "./StreamInfoModal";
import {
  StreamDiagnosticsPanel,
  buildDiagnosticsReport,
  type ClientPlaybackStats,
  type StaticStreamInfo,
} from "./StreamDiagnosticsPanel";
import { parseVtt } from "@/lib/playback-client";
import { subtitleCueCss, type SubtitleStyle } from "@/lib/profile-preferences";
import { NextEpisodeOverlay } from "./NextEpisodeOverlay";
import type { StreamTrack } from "@/types/media-tracks";
import type { StreamPlaybackInfo } from "@/types/stream-info";

interface VideoPlayerProps {
  src: string;
  title: string;
  poster?: string;
  initialProgress?: number;
  onProgress?: (seconds: number, percent: number) => void;
  onEnded?: () => void;
  autoAdvanceNext?: boolean;
  onNextEpisode?: () => void;
  audioTracks?: StreamTrack[];
  subtitleTracks?: StreamTrack[];
  audioIndex?: number;
  subtitleIndex?: number | null;
  onAudioChange?: (index: number) => void;
  onSubtitleChange?: (index: number | null) => void;
  onRequestTranscode?: () => void;
  transcodeAvailable?: boolean;
  isDirectPlay?: boolean;
  qualityHint?: string | null;
  streamInfo?: StreamPlaybackInfo;
  seriesPlayback?: {
    season: number;
    episode: number;
    hasNextEpisode: boolean;
    onNextEpisode?: () => void;
    onOpenEpisodes?: () => void;
  };
  trackSwitching?: boolean;
  onDownload?: () => void;
  /**
   * Engine sessions: video.currentTime 0 corresponds to movie time `offset`; `duration` is the
   * whole title (the HLS playlist only covers what has been produced so far).
   */
  timeline?: { offset: number; duration?: number | null };
  /** Called for user seeks (movie time). Return true when the stream is being restarted there. */
  onSeekRequest?: (movieTime: number) => Promise<boolean>;
  /** Throttled playback position (movie time) for the engine heartbeat. */
  onPositionReport?: (movieTime: number) => void;
  /** Resume point (movie time) for progressive/direct sources. */
  resumeAt?: number;
  /** Rich diagnostics for the Stream Information panel (engine playback). */
  diagnostics?: StaticStreamInfo;
  /** Text subtitles extracted by the media engine (WebVTT, source timeline). */
  sidecarSubtitle?: { url: string; sourceStartTime: number } | null;
  bufferProfile?: "auto" | "low" | "balanced" | "high";
  /** Concise, user-facing notice (e.g. engine offline fallback). */
  notice?: string | null;
  /** Signed URL a Chromecast receiver can load without the session cookie. */
  castSrc?: string;
  /** Opens the Change Video Source panel (right-click menu and control bar). */
  onChangeSource?: () => void;
  /** Playback quality (resolution cap); null = automatic. */
  quality?: { current: number | null; options: number[]; onChange: (height: number | null) => void };
  subtitleStyle?: SubtitleStyle;
  onSubtitleStyleChange?: (style: SubtitleStyle) => void;
  subtitleOffsetMs?: number;
  onSubtitleOffsetChange?: (ms: number) => void;
  forcedSubtitles?: boolean;
  onForcedSubtitlesChange?: (value: boolean) => void;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VideoPlayer({
  src,
  title,
  poster,
  initialProgress = 0,
  onProgress,
  onEnded,
  autoAdvanceNext,
  onNextEpisode,
  audioTracks = [],
  subtitleTracks = [],
  audioIndex = 0,
  subtitleIndex = null,
  onAudioChange,
  onSubtitleChange,
  onRequestTranscode,
  transcodeAvailable,
  isDirectPlay,
  qualityHint,
  streamInfo,
  seriesPlayback,
  trackSwitching,
  onDownload,
  timeline,
  onSeekRequest,
  onPositionReport,
  resumeAt,
  diagnostics,
  sidecarSubtitle,
  bufferProfile = "auto",
  notice,
  castSrc,
  onChangeSource,
  quality,
  subtitleStyle,
  onSubtitleStyleChange,
  subtitleOffsetMs = 0,
  onSubtitleOffsetChange,
  forcedSubtitles,
  onForcedSubtitlesChange,
}: VideoPlayerProps) {
  const [showQuality, setShowQuality] = useState(false);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  const offset = timeline?.offset ?? 0;
  const offsetRef = useRef(offset);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  // Playback measurements for the diagnostics panel (refs: updating them must not re-render).
  const metricsRef = useRef({
    srcSetAt: 0,
    startupMs: null as number | null,
    started: false,
    rebufferEvents: 0,
    rebufferMs: 0,
    waitingSince: 0,
    lastThroughput: null as number | null,
    lastLatency: null as number | null,
    segmentErrors: 0,
  });
  const lastReportRef = useRef(0);
  /** Video time to jump to once HLS.js has reloaded a growing (EVENT) playlist that covers it. */
  const pendingSeekRef = useRef<number | null>(null);
  /** Movie time shown while the engine restarts the stream at a far seek target. */
  const restartTargetRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const hlsRef = useRef<Hls | null>(null);
  const bufferTierRef = useRef<BufferTier>(qualityTierFromHint(qualityHint));
  const autoplayAttemptedRef = useRef(false);
  const lastSubtitleRef = useRef<number | null>(null);
  const audioGraphRef = useRef<{
    ctx: AudioContext;
    delay: DelayNode;
  } | null>(null);

  const [initialBuffering, setInitialBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoWidth, setVideoWidth] = useState(0);
  const [videoHeight, setVideoHeight] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showStreamInfo, setShowStreamInfo] = useState(false);
  const [diagTab, setDiagTab] = useState<"info" | "stats">("info");
  const [menuNotice, setMenuNotice] = useState<string | null>(null);
  const [showSyncPanel, setShowSyncPanel] = useState(false);
  const [audioDelayMs, setAudioDelayMs] = useState(0);
  const [externalSubUrl, setExternalSubUrl] = useState<string | null>(null);
  const [externalSubName, setExternalSubName] = useState<string | null>(null);
  const [externalSubEnabled, setExternalSubEnabled] = useState(false);
  const [showNextEpisode, setShowNextEpisode] = useState(false);

  const showAirPlay = isSafariBrowser();

  const isHls = isHlsSource(src);
  const useNativeHls = isHls && isSafariBrowser();

  const playbackSrc = buildRemotePlaybackUrl(src);

  const captionsOn =
    externalSubEnabled || (subtitleIndex !== null && !externalSubEnabled);

  const { castReady, casting, castError, startCast, stopCast, clearCastError } = useCast({
    title,
    src: castSrc ?? src,
    poster,
    videoRef,
    currentTime,
  });

  const ensureAudioGraph = useCallback((video: HTMLVideoElement) => {
    if (audioGraphRef.current) return audioGraphRef.current;
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(video);
    const delay = ctx.createDelay(10.0);
    delay.delayTime.value = 0;
    source.connect(delay);
    delay.connect(ctx.destination);
    audioGraphRef.current = { ctx, delay };
    return audioGraphRef.current;
  }, []);

  const applyAudioDelay = useCallback(
    (ms: number) => {
      const video = videoRef.current;
      if (!video) return;
      setAudioDelayMs(ms);
      const graph = ensureAudioGraph(video);
      graph.delay.delayTime.value = Math.max(0, ms) / 1000;
      void graph.ctx.resume().catch(() => undefined);
    },
    [ensureAudioGraph]
  );

  const bumpAudioLater = useCallback(() => {
    applyAudioDelay(Math.min(5000, audioDelayMs + 50));
  }, [applyAudioDelay, audioDelayMs]);

  const bumpAudioEarlier = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const seekBy = 0.05;
    video.currentTime = Math.min(
      Math.max(0, (video.duration || Infinity) - 0.25),
      video.currentTime + seekBy
    );
    applyAudioDelay(Math.max(0, audioDelayMs - 50));
  }, [applyAudioDelay, audioDelayMs]);

  const resetAudioSync = useCallback(() => {
    applyAudioDelay(0);
  }, [applyAudioDelay]);

  const attemptAutoplay = useCallback(async () => {
    const video = videoRef.current;
    if (!video || autoplayAttemptedRef.current) return;
    autoplayAttemptedRef.current = true;
    setInitialBuffering(true);
    try {
      await playWhenBuffered(video, getMinPlayBufferSeconds(bufferTierRef.current));
      setPlaying(true);
    } catch {
      /* Browser may block autoplay until user interacts */
    } finally {
      setInitialBuffering(false);
    }
  }, []);

  useEffect(() => {
    bufferTierRef.current = qualityTierFromHint(qualityHint);
  }, [qualityHint, src]);

  useEffect(() => {
    setPlaybackError(null);
    setShowNextEpisode(false);
    autoplayAttemptedRef.current = false;
    const m = metricsRef.current;
    m.srcSetAt = performance.now();
    m.started = false;
    m.waitingSince = 0;
    // A pending in-stream seek belongs to the previous stream.
    pendingSeekRef.current = null;
    setAudioDelayMs(0);
    if (audioGraphRef.current) {
      audioGraphRef.current.delay.delayTime.value = 0;
    }
  }, [src]);

  useEffect(() => {
    return () => {
      if (externalSubUrl) URL.revokeObjectURL(externalSubUrl);
    };
  }, [externalSubUrl]);

  useEffect(() => {
    if (subtitleIndex !== null) {
      lastSubtitleRef.current = subtitleIndex;
      if (externalSubEnabled) setExternalSubEnabled(false);
    }
  }, [subtitleIndex, externalSubEnabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !externalSubUrl || !externalSubEnabled) return;
    const timer = window.setTimeout(() => {
      for (const track of video.textTracks) {
        track.mode = "showing";
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, [externalSubUrl, externalSubEnabled, src]);

  const updateBufferTier = useCallback((tier: BufferTier) => {
    if (tier === bufferTierRef.current) return;
    bufferTierRef.current = tier;
    const hls = hlsRef.current;
    if (hls) applyHlsBufferTier(hls, tier);
  }, []);

  const resolveHlsSubtitleTrackIndex = useCallback(
    (hls: Hls, streamIndex: number | null): number => {
      if (streamIndex === null) return -1;
      if (!hls.subtitleTracks.length) return -1;

      const byId = hls.subtitleTracks.findIndex((t) => t.id === streamIndex);
      if (byId >= 0) return byId;

      const probeTrack = subtitleTracks.find((t) => t.index === streamIndex);
      if (probeTrack) {
        const byLang = hls.subtitleTracks.findIndex((t) => {
          const lang = (t.lang || t.name || "").toLowerCase();
          const probeLang = (probeTrack.language || probeTrack.title || "").toLowerCase();
          return probeLang && (lang === probeLang || lang.startsWith(probeLang.slice(0, 2)));
        });
        if (byLang >= 0) return byLang;
      }

      const englishIdx = hls.subtitleTracks.findIndex((t) =>
        /en|english/i.test(t.name || t.lang || "")
      );
      return englishIdx >= 0 ? englishIdx : 0;
    },
    [subtitleTracks]
  );

  const applyHlsSubtitleSelection = useCallback(
    (hls: Hls, streamIndex: number | null) => {
      if (!hls.subtitleTracks.length || externalSubEnabled) return;
      hls.subtitleDisplay = streamIndex !== null;
      hls.subtitleTrack =
        streamIndex === null ? -1 : resolveHlsSubtitleTrackIndex(hls, streamIndex);
    },
    [externalSubEnabled, resolveHlsSubtitleTrackIndex]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const tier = qualityTierFromHint(qualityHint);
    bufferTierRef.current = tier;

    if (isHls && !useNativeHls && Hls.isSupported()) {
      const profileTier: BufferTier =
        bufferProfile === "low" ? "sd" : bufferProfile === "balanced" ? "hd" : bufferProfile === "high" ? "uhd" : tier;
      const hls = new Hls(buildHlsConfig(profileTier));
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        const st = data.frag.stats;
        const loadMs = st.loading.end - st.loading.start;
        if (loadMs > 0 && st.loaded > 0) metricsRef.current.lastThroughput = (st.loaded * 8 * 1000) / loadMs;
        metricsRef.current.lastLatency = st.loading.first - st.loading.start;
      });
      let recoveredMedia = false;
      let networkRetries = 0;
      hls.loadSource(playbackSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const maxHeight = Math.max(0, ...data.levels.map((level) => level.height || 0));
        if (maxHeight > 0) {
          updateBufferTier(qualityTierFromHeight(maxHeight));
        }
        applyHlsSubtitleSelection(hls, subtitleIndex);
        const details = hls.levels[0]?.details;
        if (details?.live && pendingSeekRef.current == null) video.currentTime = 0;
        void attemptAutoplay();
      });
      // A seek past the end of the playlist HLS.js last loaded: once the reloaded playlist covers the
      // target (and the seekable range is updated), jump there.
      hls.on(Hls.Events.LEVEL_UPDATED, (_e, data) => {
        const pending = pendingSeekRef.current;
        if (pending == null || data.details.edge < pending) return;
        window.setTimeout(() => {
          if (pendingSeekRef.current == null) return;
          pendingSeekRef.current = null;
          video.currentTime = pending;
          void video.play().catch(() => undefined);
        }, 0);
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        applyHlsSubtitleSelection(hls, subtitleIndex);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) metricsRef.current.segmentErrors += 1;
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
          networkRetries += 1;
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
          recoveredMedia = true;
          hls.recoverMediaError();
          return;
        }
        setPlaybackError("Playback stopped unexpectedly.");
      });
      hlsRef.current = hls;
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    video.preload = "auto";
    video.src = playbackSrc;
    const onReady = () => void attemptAutoplay();
    video.addEventListener("loadeddata", onReady, { once: true });
    return () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeAttribute("src");
      video.load();
    };
  }, [playbackSrc, isHls, useNativeHls, qualityHint, updateBufferTier, attemptAutoplay, bufferProfile]);

  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    applyHlsSubtitleSelection(hls, subtitleIndex);
  }, [subtitleIndex, externalSubEnabled, applyHlsSubtitleSelection]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isHls || (initialProgress <= 0 && !resumeAt)) return;
    const setStart = () => {
      if (resumeAt && resumeAt > 0) {
        video.currentTime = Math.max(0, resumeAt - offsetRef.current);
      } else if (video.duration && initialProgress > 0) {
        video.currentTime = (initialProgress / 100) * video.duration;
      }
    };
    video.addEventListener("loadedmetadata", setStart, { once: true });
    return () => video.removeEventListener("loadedmetadata", setStart);
  }, [initialProgress, isHls, src, resumeAt]);

  // Engine-extracted text subtitles: fetched (and refreshed while extraction runs) into a TextTrack,
  // shifted from the source timeline onto this generation's video timeline.
  const sidecarTrackRef = useRef<TextTrack | null>(null);
  const sidecarCuesRef = useRef<ReturnType<typeof parseVtt>>([]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!sidecarTrackRef.current) sidecarTrackRef.current = video.addTextTrack("subtitles", "Subtitles", "en");
    const track = sidecarTrackRef.current;
    const clear = () => {
      for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue);
    };
    clear();
    if (!sidecarSubtitle) {
      track.mode = "disabled";
      return;
    }
    track.mode = "showing";
    let cancelled = false;
    let timer: number | undefined;
    const shift = sidecarSubtitle.sourceStartTime + offset - subtitleOffsetMs / 1000;
    const load = async () => {
      const res = await fetch(`${sidecarSubtitle.url}?from=${Math.max(0, offsetRef.current + (videoRef.current?.currentTime ?? 0))}`).catch(() => null);
      if (cancelled || !res?.ok) return;
      const cues = parseVtt(await res.text());
      sidecarCuesRef.current = cues;
      clear();
      for (const c of cues) {
        const start = c.start - shift;
        const end = c.end - shift;
        if (end > 0) track.addCue(new VTTCue(Math.max(0, start), end, c.text));
      }
      if (res.headers.get("x-subtitle-complete") !== "1") timer = window.setTimeout(load, 8000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [sidecarSubtitle, offset, subtitleOffsetMs]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    document.addEventListener("click", closeMenu);
    return () => document.removeEventListener("click", closeMenu);
  }, []);

  // Read at fire time: a timer armed before a menu opened must not hide the controls under it.
  const menuOpenRef = useRef(false);

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // Never hide the controls under an open menu (audio/subtitles, quality).
      if (playing && !menuOpenRef.current) setShowControls(false);
    }, 3000);
  }, [playing]);

  const setMenuOpen = useCallback(
    (track: boolean, quality: boolean) => {
      const wasOpen = menuOpenRef.current;
      menuOpenRef.current = track || quality;
      setTrackMenuOpen(track);
      setShowQuality(quality);
      if (menuOpenRef.current) setShowControls(true);
      else if (wasOpen) resetHideTimer(); // re-arm the fade once the last menu closes
    },
    [resetHideTimer]
  );
  const toggleQualityMenu = () => setMenuOpen(trackMenuOpen, !showQuality);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setInitialBuffering(true);
      try {
        await playWhenBuffered(video, getMinPlayBufferSeconds(bufferTierRef.current));
        setPlaying(true);
      } catch {
        setPlaybackError("Playback failed to start.");
      } finally {
        setInitialBuffering(false);
      }
    } else {
      video.pause();
      setPlaying(false);
    }
    resetHideTimer();
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch {
      /* browser may block fullscreen */
    }
    resetHideTimer();
  };

  const handleVideoClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      void togglePlay();
      clickTimer.current = null;
    }, 250);
  };

  const handleVideoDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    void toggleFullscreen();
  };

  const stopClickPropagation = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const totalDuration = () => {
    const video = videoRef.current;
    return timeline?.duration || (video && Number.isFinite(video.duration) ? video.duration + offsetRef.current : 0);
  };

  /** Seek in movie time; restarts the stream through the engine when the target is not encoded yet. */
  const seekTo = async (movieTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, Math.min(totalDuration() || movieTime, movieTime));
    setCurrentTime(target);
    if (onSeekRequest) {
      // Pause first: if the engine restarts the stream, the new source may already be attached (and
      // autoplaying) by the time the request resolves, so pausing afterwards would stop the new one.
      restartTargetRef.current = target;
      const wasPlaying = !video.paused;
      video.pause();
      if (await onSeekRequest(target)) {
        setInitialBuffering(true);
        return;
      }
      restartTargetRef.current = null;
      if (wasPlaying) void video.play().catch(() => undefined);
    }
    const videoTime = Math.max(0, target - offsetRef.current);
    const hls = hlsRef.current;
    const seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (hls && hls.levels[0]?.details?.live && videoTime > seekableEnd + 0.25) {
      // The engine has produced this part, but HLS.js only refreshes a growing playlist every target
      // duration (~10 s for stream-copied video). Reload the playlist now and start loading there.
      pendingSeekRef.current = videoTime;
      hls.config.startPosition = videoTime;
      hls.loadSource(playbackSrc);
      return;
    }
    video.currentTime = videoTime;
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = e.currentTarget;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    void seekTo(pct * totalDuration());
    resetHideTimer();
  };

  const skip = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    void seekTo(offsetRef.current + video.currentTime + seconds);
    resetHideTimer();
  };

  const collectStats = (): ClientPlaybackStats => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    const m = metricsRef.current;
    const ranges: Array<[number, number]> = [];
    if (video) for (let i = 0; i < video.buffered.length; i++) ranges.push([video.buffered.start(i) + offsetRef.current, video.buffered.end(i) + offsetRef.current]);
    const q = video?.getVideoPlaybackQuality?.();
    const level = hls?.levels?.[hls.currentLevel >= 0 ? hls.currentLevel : 0];
    return {
      currentTime: video?.currentTime ?? 0,
      movieTime: offsetRef.current + (video?.currentTime ?? 0),
      duration: totalDuration(),
      bufferedAhead: video ? getBufferedAhead(video) : 0,
      bufferedRanges: ranges,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      droppedFrames: q ? q.droppedVideoFrames : null,
      decodedFrames: q ? q.totalVideoFrames : null,
      startupMs: m.startupMs,
      rebufferEvents: m.rebufferEvents,
      rebufferMs: m.rebufferMs + (m.waitingSince ? performance.now() - m.waitingSince : 0),
      bandwidthEstimate: hls && Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
      lastSegmentThroughput: m.lastThroughput,
      lastSegmentLatencyMs: m.lastLatency,
      segmentErrors: m.segmentErrors,
      playerKind: hls ? "hls.js" : isHls ? "native-hls" : "progressive",
      hlsLevelCodecs: level ? [level.videoCodec, level.audioCodec].filter(Boolean).join(", ") || null : null,
      playing,
    };
  };

  const copyDiagnostics = async () => {
    const info: StaticStreamInfo = diagnostics ?? { title, session: null };
    const text = JSON.stringify(buildDiagnosticsReport(info, collectStats(), null), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setMenuNotice("Diagnostics copied");
    } catch {
      console.info(text);
      setMenuNotice("Diagnostics written to the console");
    }
    window.setTimeout(() => setMenuNotice(null), 2500);
  };

  const reportProblem = async () => {
    const info: StaticStreamInfo = diagnostics ?? { title, session: null };
    const res = await fetch("/api/playback/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDiagnosticsReport(info, collectStats(), null)),
    }).catch(() => null);
    setMenuNotice(res?.ok ? "Problem report saved" : "Could not save the report");
    window.setTimeout(() => setMenuNotice(null), 2500);
  };

  const toggleCaptions = () => {
    if (externalSubUrl) {
      const next = !externalSubEnabled;
      setExternalSubEnabled(next);
      if (next) onSubtitleChange?.(null);
      return;
    }
    if (subtitleIndex !== null) {
      lastSubtitleRef.current = subtitleIndex;
      onSubtitleChange?.(null);
      return;
    }
    if (lastSubtitleRef.current !== null) {
      onSubtitleChange?.(lastSubtitleRef.current);
      return;
    }
    if (subtitleTracks.length > 0) {
      onSubtitleChange?.(subtitleTracks[0].index);
    }
  };

  const handleExternalSubtitle = async (file: File) => {
    try {
      if (externalSubUrl) URL.revokeObjectURL(externalSubUrl);
      const url = await subtitleFileToObjectUrl(file);
      setExternalSubUrl(url);
      setExternalSubName(file.name);
      setExternalSubEnabled(true);
      const hls = hlsRef.current;
      if (hls) hls.subtitleDisplay = false;
    } catch (err) {
      setPlaybackError(err instanceof Error ? err.message : "Could not load subtitle file");
    }
  };

  const handleAirPlay = async () => {
    setRemoteError(null);
    const video = videoRef.current as HTMLVideoElement & {
      webkitShowPlaybackTargetPicker?: () => void;
    };
    if (!video || typeof video.webkitShowPlaybackTargetPicker !== "function") return;

    try {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
        video.src = playbackSrc;
        video.load();
        await video.play().catch(() => undefined);
      }
      video.webkitShowPlaybackTargetPicker();
    } catch {
      setRemoteError("Could not open AirPlay picker.");
    }
  };

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video || e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          void togglePlay();
          break;
        case "f":
        case "F":
          e.preventDefault();
          void toggleFullscreen();
          break;
        case "m":
        case "M":
          e.preventDefault();
          video.muted = !video.muted;
          setMuted(video.muted);
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (seriesPlayback?.hasNextEpisode && seriesPlayback.onNextEpisode && e.shiftKey) {
            seriesPlayback.onNextEpisode();
          } else {
            skip(10);
          }
          break;
        case "c":
        case "C":
          e.preventDefault();
          toggleCaptions();
          break;
        case "s":
        case "S":
          if (onChangeSource) {
            e.preventDefault();
            onChangeSource();
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [seriesPlayback, togglePlay, toggleFullscreen, skip, toggleCaptions, onChangeSource]);

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedAhead = videoRef.current ? getBufferedAhead(videoRef.current) : 0;

  const showTrackSelector =
    (audioTracks.length > 0 && onAudioChange) || Boolean(onSubtitleChange);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full bg-black"
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
      onContextMenu={handleContextMenu}
    >
      {subtitleStyle && <style>{subtitleCueCss(subtitleStyle)}</style>}
      <div
        className="absolute inset-0"
        onClick={handleVideoClick}
        onDoubleClick={handleVideoDoubleClick}
      >
        <video
          ref={videoRef}
          className="h-full w-full"
          poster={poster}
          playsInline
          autoPlay
          disableRemotePlayback={false}
          {...({ "x-webkit-airplay": "allow", airplay: "allow" } as React.VideoHTMLAttributes<HTMLVideoElement>)}
          onWaiting={() => {
            setBuffering(true);
            const m = metricsRef.current;
            if (m.started && !m.waitingSince) {
              m.waitingSince = performance.now();
              m.rebufferEvents += 1;
            }
          }}
          onCanPlay={() => setBuffering(false)}
          onPlaying={() => {
            if (restartTargetRef.current != null) {
              restartTargetRef.current = null;
              setInitialBuffering(false);
            }
            const m = metricsRef.current;
            if (!m.started) {
              m.started = true;
              m.startupMs = Math.round(performance.now() - m.srcSetAt);
            }
            if (m.waitingSince) {
              m.rebufferMs += performance.now() - m.waitingSince;
              m.waitingSince = 0;
            }
            setBuffering(false);
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setVideoWidth(v.videoWidth);
            setVideoHeight(v.videoHeight);
            if (v.videoHeight > 0) {
              updateBufferTier(qualityTierFromHeight(v.videoHeight));
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            const movieTime = offsetRef.current + v.currentTime;
            const total = timeline?.duration || (Number.isFinite(v.duration) ? v.duration + offsetRef.current : 0);
            // While restarting for a far seek, keep showing the target instead of the old position.
            if (restartTargetRef.current != null) return;
            setCurrentTime(movieTime);
            setDuration(total || 0);
            const stillEncoding = !timeline?.duration && Boolean(hlsRef.current?.levels?.[0]?.details?.live);
            if (onProgress && total && !stillEncoding) {
              onProgress(movieTime, (movieTime / total) * 100);
            }
            if (onPositionReport && Math.abs(movieTime - lastReportRef.current) >= 2) {
              lastReportRef.current = movieTime;
              onPositionReport(movieTime);
            }
          }}
          onEnded={() => {
            setPlaying(false);
            if (autoAdvanceNext && onNextEpisode) {
              setShowNextEpisode(true);
              return;
            }
            onEnded?.();
          }}
          onError={() => {
            if (isHls) return;
            setPlaybackError(
              notice
                ? "This video can't be played in this browser while the media engine is offline."
                : "This video can't be played right now."
            );
          }}
        >
          {externalSubUrl && externalSubEnabled && (
            <track
              kind="subtitles"
              src={externalSubUrl}
              label={externalSubName ?? "External"}
              srcLang="en"
              default
            />
          )}
        </video>
      </div>

      {contextMenu && (
        <div
          className="fixed z-[90] min-w-[12rem] rounded-md bg-zinc-900 py-1 shadow-xl ring-1 ring-white/10"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={stopClickPropagation}
        >
          {onChangeSource && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
              onClick={() => {
                setContextMenu(null);
                onChangeSource();
              }}
              data-testid="menu-change-source"
            >
              <Layers className="h-4 w-4" />
              Change video source
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              setDiagTab("info");
              setShowStreamInfo(true);
            }}
          >
            <Info className="h-4 w-4" />
            Stream information
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              setDiagTab("stats");
              setShowStreamInfo(true);
            }}
          >
            <Activity className="h-4 w-4" />
            Playback statistics
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              void copyDiagnostics();
            }}
          >
            <Copy className="h-4 w-4" />
            Copy stream diagnostics
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
            onClick={() => {
              setContextMenu(null);
              void reportProblem();
            }}
          >
            <Flag className="h-4 w-4" />
            Report playback problem
          </button>
          {onDownload && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
              onClick={() => {
                setContextMenu(null);
                onDownload();
              }}
            >
              <Download className="h-4 w-4" />
              Download video
            </button>
          )}
        </div>
      )}

      {menuNotice && (
        <div className="pointer-events-none absolute left-1/2 top-6 z-[85] -translate-x-1/2 rounded bg-black/80 px-4 py-2 text-sm">
          {menuNotice}
        </div>
      )}

      {showStreamInfo && diagnostics && (
        <StreamDiagnosticsPanel
          info={diagnostics}
          stats={collectStats}
          initialTab={diagTab}
          onClose={() => setShowStreamInfo(false)}
        />
      )}

      {showStreamInfo && !diagnostics && (
        <StreamInfoModal
          info={{
            streamUrl: src,
            isDirectPlay,
            qualityHint,
            ...streamInfo,
            audioTracks,
            subtitleTracks,
            audioIndex,
            subtitleIndex,
          }}
          live={{
            width: videoWidth,
            height: videoHeight,
            duration,
            currentTime,
            buffered: bufferedAhead,
            playing,
            audioSyncMs: audioDelayMs,
            externalSubtitle: externalSubEnabled ? externalSubName : null,
          }}
          onClose={() => setShowStreamInfo(false)}
        />
      )}

      {playbackError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
          <p className="max-w-md text-lg">{playbackError}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setPlaybackError(null);
                const v = videoRef.current;
                if (hlsRef.current) {
                  hlsRef.current.startLoad();
                  hlsRef.current.recoverMediaError();
                } else if (v) {
                  v.load();
                }
                void v?.play().catch(() => undefined);
              }}
              className="rounded bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/80"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                setDiagTab("stats");
                setShowStreamInfo(true);
              }}
              className="rounded border border-white/40 px-4 py-2 text-sm hover:bg-white/10"
            >
              Technical details
            </button>
          </div>
          {transcodeAvailable && onRequestTranscode && isDirectPlay && (
            <button
              type="button"
              onClick={() => {
                setPlaybackError(null);
                onRequestTranscode();
              }}
              className="rounded bg-netflix-red px-4 py-2 text-sm font-semibold"
            >
              Switch to Transcode
            </button>
          )}
        </div>
      )}

      {showNextEpisode && onNextEpisode && (
        <NextEpisodeOverlay
          onPlay={() => {
            setShowNextEpisode(false);
            onNextEpisode();
          }}
          onDismiss={() => setShowNextEpisode(false)}
        />
      )}

      {(buffering || initialBuffering || trackSwitching) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" data-testid="player-loading">
          <div className="h-14 w-14 animate-spin rounded-full border-4 border-white/20 border-t-netflix-red" />
        </div>
      )}

      <div
        className={cn(
          "absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-300",
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={stopClickPropagation}
        onDoubleClick={handleVideoDoubleClick}
      >
        <div className="px-4 pb-2 pt-16 md:px-8">
          <h2 className="mb-4 text-lg font-semibold md:text-xl">{title}</h2>

          <div
            className="group mb-3 h-1 cursor-pointer rounded bg-white/30 transition-all hover:h-1.5"
            onClick={seek}
          >
            <div
              className="relative h-full rounded bg-netflix-red"
              style={{ width: `${progressPct}%` }}
            >
              <div className="absolute -right-1.5 -top-1 h-3.5 w-3.5 scale-0 rounded-full bg-netflix-red transition group-hover:scale-100" />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 md:gap-4">
              <button type="button" onClick={() => void togglePlay()} className="text-white hover:text-netflix-light-gray">
                {playing ? <Pause className="h-7 w-7 md:h-8 md:w-8" /> : <Play className="h-7 w-7 fill-current md:h-8 md:w-8" />}
              </button>
              <button
                type="button"
                onClick={() => skip(-10)}
                className="hidden text-white hover:text-netflix-light-gray sm:block"
                title="Back 10 seconds"
              >
                <SkipBack className="h-5 w-5" />
              </button>
              {seriesPlayback?.hasNextEpisode && seriesPlayback.onNextEpisode ? (
                <button
                  type="button"
                  onClick={seriesPlayback.onNextEpisode}
                  className="hidden items-center gap-1 text-white hover:text-netflix-light-gray sm:flex"
                  title="Next episode"
                >
                  <ChevronRight className="h-6 w-6" />
                  <span className="text-xs font-medium">Next Ep</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => skip(10)}
                  className="hidden text-white hover:text-netflix-light-gray sm:block"
                  title="Forward 10 seconds"
                >
                  <SkipForward className="h-5 w-5" />
                </button>
              )}

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSyncPanel((v) => !v)}
                  className={cn(
                    "text-white hover:text-netflix-light-gray",
                    audioDelayMs > 0 && "text-yellow-300"
                  )}
                  title="Audio sync"
                >
                  <Gauge className="h-5 w-5" />
                </button>
                {showSyncPanel && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 rounded bg-black/95 p-3 text-sm shadow-xl ring-1 ring-white/10">
                    <p className="mb-2 text-xs text-netflix-gray">Sync audio with video</p>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={bumpAudioEarlier}
                        className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
                      >
                        −50ms
                      </button>
                      <span className="font-mono text-xs">{audioDelayMs}ms delay</span>
                      <button
                        type="button"
                        onClick={bumpAudioLater}
                        className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
                      >
                        +50ms
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={resetAudioSync}
                      className="mt-2 w-full rounded bg-white/10 py-1 text-xs hover:bg-white/20"
                    >
                      Reset sync
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    v.muted = !v.muted;
                    setMuted(v.muted);
                  }}
                >
                  {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setVolume(val);
                    if (videoRef.current) {
                      videoRef.current.volume = val;
                      videoRef.current.muted = val === 0;
                      setMuted(val === 0);
                    }
                  }}
                  className="hidden w-20 accent-netflix-red sm:block"
                />
              </div>
              <span className="text-xs text-netflix-light-gray md:text-sm">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <div className="flex items-center gap-3">
              {seriesPlayback?.onOpenEpisodes && (
                <button
                  type="button"
                  onClick={seriesPlayback.onOpenEpisodes}
                  className="flex items-center gap-1 text-white hover:text-netflix-light-gray"
                  title="Episodes"
                >
                  <ListVideo className="h-5 w-5" />
                  <span className="hidden text-xs md:inline">Episodes</span>
                </button>
              )}

              {(onSubtitleChange || subtitleTracks.length > 0 || externalSubUrl) && (
                <button
                  type="button"
                  onClick={toggleCaptions}
                  className={cn(
                    "text-white hover:text-netflix-light-gray",
                    captionsOn && "text-netflix-red"
                  )}
                  title={captionsOn ? "Turn off captions" : "Turn on captions"}
                >
                  <Subtitles className="h-5 w-5" />
                </button>
              )}

              {showTrackSelector && (
                <TrackSelector
                  audioTracks={audioTracks}
                  subtitleTracks={subtitleTracks}
                  audioIndex={audioIndex}
                  subtitleIndex={externalSubEnabled ? null : subtitleIndex}
                  onAudioChange={onAudioChange ?? (() => undefined)}
                  onSubtitleChange={onSubtitleChange ?? (() => undefined)}
                  onExternalSubtitle={handleExternalSubtitle}
                  externalSubtitleName={externalSubEnabled ? externalSubName : null}
                  subtitleStyle={subtitleStyle}
                  onSubtitleStyleChange={onSubtitleStyleChange}
                  subtitleOffsetMs={subtitleOffsetMs}
                  onSubtitleOffsetChange={onSubtitleOffsetChange}
                  forcedOnly={forcedSubtitles}
                  onForcedOnlyChange={onForcedSubtitlesChange}
                  onOpenChange={(open) => setMenuOpen(open, showQuality)}
                />
              )}

              {transcodeAvailable && onRequestTranscode && isDirectPlay && (
                <button
                  type="button"
                  onClick={onRequestTranscode}
                  className="text-xs text-netflix-light-gray hover:text-white"
                  title="Transcode for unsupported codecs or audio/subtitle selection"
                >
                  Transcode
                </button>
              )}

              {quality && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={toggleQualityMenu}
                    className="flex items-center gap-1 text-white hover:text-netflix-light-gray"
                    title="Playback quality"
                    aria-label="Playback quality"
                  >
                    <SlidersHorizontal className="h-5 w-5" />
                    <span className="hidden text-xs md:inline">{quality.current ? `${quality.current}p` : "Auto"}</span>
                  </button>
                  {showQuality && (
                    <div className="absolute bottom-full right-0 mb-2 w-44 rounded bg-black/95 py-1 text-sm shadow-xl ring-1 ring-white/10" data-testid="quality-menu">
                      <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-netflix-gray">Maximum quality</p>
                      {[null, ...quality.options].map((h) => (
                        <button
                          key={h ?? "auto"}
                          type="button"
                          onClick={() => {
                            setMenuOpen(trackMenuOpen, false);
                            quality.onChange(h);
                          }}
                          className={cn("block w-full px-3 py-1.5 text-left hover:bg-white/10", quality.current === h && "text-netflix-red")}
                        >
                          {h ? (h >= 2160 ? "4K (2160p)" : `${h}p`) : "Auto (best available)"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {onChangeSource && (
                <button
                  type="button"
                  onClick={onChangeSource}
                  className="flex items-center gap-1 text-white hover:text-netflix-light-gray"
                  title="Change video source"
                  aria-label="Change video source"
                  data-testid="change-source"
                >
                  <Layers className="h-5 w-5" />
                  <span className="hidden text-xs lg:inline">Source</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setDiagTab("info");
                  setShowStreamInfo((v) => !v);
                }}
                className="text-white hover:text-netflix-light-gray"
                title="Stream information"
                aria-label="Stream information"
              >
                <Info className="h-5 w-5" />
              </button>

              {showAirPlay && (
                <button
                  type="button"
                  onClick={() => void handleAirPlay()}
                  className="text-white hover:text-netflix-light-gray"
                  title="AirPlay"
                >
                  <Airplay className="h-5 w-5" />
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  clearCastError();
                  if (casting) stopCast();
                  else void startCast();
                }}
                disabled={!castReady}
                className={cn(
                  "text-white hover:text-netflix-light-gray disabled:opacity-40",
                  casting && "text-netflix-red"
                )}
                title={castReady ? "Cast to Chromecast" : "Chromecast loading…"}
              >
                <Cast className="h-5 w-5" />
              </button>

              <button type="button" onClick={() => void toggleFullscreen()} className="text-white hover:text-netflix-light-gray">
                {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </button>
            </div>
          </div>
          {notice && <p className="mt-2 text-xs text-yellow-300">{notice}</p>}
          {(castError || remoteError) && (
            <p className="mt-2 text-xs text-yellow-300">{castError || remoteError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
