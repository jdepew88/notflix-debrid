"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MediaImage } from "@/components/ui/MediaImage";
import { Play, Info, Volume2, VolumeX, AlertCircle, Plus, Check } from "lucide-react";
import { motion } from "framer-motion";
import { backdropUrl, logoUrl, type HeroDetails } from "@/lib/tmdb";
import { playHrefForItem, playLabelForItem } from "@/lib/playback";
import { getMediaProgress, isInMyList, useAppStore } from "@/lib/store";
import { watchIdForItem, isSeriesItem } from "@/lib/watch-url";
import { useDetailModal } from "@/providers/DetailModalProvider";
import type { MediaItem } from "@/lib/types";
import { cn } from "@/lib/cn";

interface HeroBannerProps {
  item: MediaItem;
  videoError?: string | null;
  onHeroItemChange?: (item: MediaItem, error: string | null) => void;
  /** Profile preference: muted trailer previews in the banner (off by default). */
  autoplayPreviews?: boolean;
}

const HERO_STALL_MS = 8000;
/** Give the page a moment to settle before any preview video is loaded. */
const PREVIEW_DELAY_MS = 1800;

function formatRuntime(minutes?: number): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function HeroBanner({ item: initialItem, videoError, onHeroItemChange, autoplayPreviews = false }: HeroBannerProps) {
  const { openDetail } = useDetailModal();
  const addToMyList = useAppStore((s) => s.addToMyList);
  const removeFromMyList = useAppStore((s) => s.removeFromMyList);
  const myListVersion = useAppStore((s) => s.myListByProfile);
  const [heroItem, setHeroItem] = useState(initialItem);
  const [heroError, setHeroError] = useState<string | null>(videoError ?? null);
  const [details, setDetails] = useState<HeroDetails | null>(null);
  const backdrop = backdropUrl(heroItem.backdropPath ?? details?.backdropPath);
  const logo = logoUrl(details?.logoPath, "w500");
  const watchHref = playHrefForItem(heroItem);
  const playLabel = playLabelForItem(heroItem);
  const heroProgress = getMediaProgress(watchIdForItem(heroItem));
  const inList = isInMyList(heroItem.id);
  void myListVersion;

  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [trailerKey, setTrailerKey] = useState<string | null>(null);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [videoMode, setVideoMode] = useState<"local" | "youtube" | null>(null);
  const [muted, setMuted] = useState(true);
  const [showVideo, setShowVideo] = useState(false);
  /** The YouTube player reported it is actually playing; only then fade the image out. */
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const videoDisabledRef = useRef(false);
  void onHeroItemChange;

  const tmdbId =
    heroItem.tmdbId ??
    (heroItem.id.match(/^tmdb-(?:tv-)?(\d+)$/) ? parseInt(heroItem.id.replace(/^tmdb-(?:tv-)?/, ""), 10) : null);
  const media: "movie" | "tv" = isSeriesItem(heroItem) || heroItem.mediaType === "tv" ? "tv" : "movie";

  const previewsAllowed = autoplayPreviews && !prefersReducedMotion();

  useEffect(() => {
    setHeroItem(initialItem);
    setDetails(null);
  }, [initialItem]);

  useEffect(() => {
    setHeroError(videoError ?? null);
  }, [videoError]);

  // Title details (logo, certification, genres, year, trailer key) in one request.
  useEffect(() => {
    if (!tmdbId) return;
    let cancelled = false;
    fetch(`/api/catalog?type=hero&id=${tmdbId}&media=${media}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: HeroDetails | null) => {
        if (!cancelled && d) setDetails(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tmdbId, media]);

  // Visibility: pause previews when the tab is hidden or the hero has scrolled away.
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    const el = sectionRef.current;
    const observer = el
      ? new IntersectionObserver(([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio > 0.35), { threshold: [0, 0.35, 0.6] })
      : null;
    if (el && observer) observer.observe(el);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      observer?.disconnect();
    };
  }, []);

  const revertToPhoto = useCallback(() => {
    videoDisabledRef.current = true;
    setLocalVideoUrl(null);
    setShowVideo(false);
    setPreviewPlaying(false);
    setVideoMode(null);
    setTrailerKey(null);
  }, []);

  // Preview loading — only when the profile allows it.
  useEffect(() => {
    let cancelled = false;
    videoDisabledRef.current = false;
    setLocalVideoUrl(null);
    setTrailerKey(null);
    setVideoMode(null);
    setShowVideo(false);
    setPreviewPlaying(false);
    if (!previewsAllowed) return;

    async function loadTrailer() {
      if (cancelled || videoDisabledRef.current) return;
      // Use the key from the hero details when we have it; otherwise ask for it.
      let key = details?.trailerKey ?? null;
      if (!details && tmdbId) {
        const res = await fetch(`/api/catalog?type=hero&id=${tmdbId}&media=${media}`).catch(() => null);
        const d = res?.ok ? ((await res.json()) as HeroDetails) : null;
        if (!cancelled && d) setDetails(d);
        key = d?.trailerKey ?? null;
      }
      if (cancelled || videoDisabledRef.current || !key) return;
      setTrailerKey(key);
      setVideoMode("youtube");
      setShowVideo(true);
    }

    const timer = window.setTimeout(() => void loadTrailer(), PREVIEW_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // details.trailerKey is read when the timer fires; refetching on every details change would double-load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem.id, tmdbId, media, previewsAllowed, revertToPhoto]);

  // Local preview video (not produced by this edition; kept for a future preview source): mute + stall detection.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, localVideoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!showVideo || videoMode !== "local" || !localVideoUrl || !video) return;
    if (!inView || !pageVisible) {
      video.pause();
      return;
    }
    void video.play().catch(() => undefined);
    let lastTime = video.currentTime;
    let lastAdvance = Date.now();
    let hasStarted = false;
    const markStarted = () => {
      hasStarted = true;
      lastAdvance = Date.now();
      lastTime = video.currentTime;
      setPreviewPlaying(true);
    };
    video.addEventListener("playing", markStarted);
    const timer = window.setInterval(() => {
      if (!hasStarted || video.paused || video.ended) return;
      if (video.currentTime > lastTime + 0.05) {
        lastTime = video.currentTime;
        lastAdvance = Date.now();
        return;
      }
      if (Date.now() - lastAdvance >= HERO_STALL_MS) revertToPhoto();
    }, 1000);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener("playing", markStarted);
    };
  }, [showVideo, videoMode, localVideoUrl, revertToPhoto, inView, pageVisible]);

  // YouTube preview: control through the IFrame API (postMessage) — play/pause with visibility, mute, end.
  const ytCommand = useCallback((func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "https://www.youtube.com");
  }, []);

  useEffect(() => {
    if (videoMode !== "youtube" || !trailerKey) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== "https://www.youtube.com" || typeof e.data !== "string") return;
      let data: { event?: string; info?: unknown };
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (data.event === "onReady") {
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening" }), "https://www.youtube.com");
        ytCommand(muted ? "mute" : "unMute");
        if (inView && pageVisible) ytCommand("playVideo");
      }
      if (data.event === "onStateChange") {
        if (data.info === 1) setPreviewPlaying(true);
        if (data.info === 0) {
          // Ended: return to the still image (no endless loop of the same trailer).
          setPreviewPlaying(false);
          setShowVideo(false);
        }
      }
      if (data.event === "onError") revertToPhoto();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [videoMode, trailerKey, muted, inView, pageVisible, ytCommand, revertToPhoto]);

  useEffect(() => {
    if (videoMode !== "youtube" || !showVideo) return;
    ytCommand(inView && pageVisible ? "playVideo" : "pauseVideo");
  }, [inView, pageVisible, videoMode, showVideo, ytCommand]);

  useEffect(() => {
    if (videoMode === "youtube") ytCommand(muted ? "mute" : "unMute");
  }, [muted, videoMode, ytCommand]);

  const hasVideo = showVideo && (videoMode === "local" ? Boolean(localVideoUrl) : Boolean(trailerKey));
  const year = details?.year ?? heroItem.releaseDate?.slice(0, 4);
  const runtime = formatRuntime(details?.runtime ?? heroItem.runtime);
  const genres = (details?.genres?.length ? details.genres : heroItem.genres ?? []).slice(0, 3);
  const certification = details?.certification ?? heroItem.certification;
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <section
      ref={sectionRef}
      className="relative h-[72vh] min-h-[420px] max-h-[920px] w-full md:h-[80vh]"
      data-testid="hero"
      data-preview={hasVideo && previewPlaying ? "video" : "image"}
    >
      {backdrop ? (
        <MediaImage
          src={backdrop}
          alt=""
          fill
          priority
          className={cn("object-cover object-[center_20%] transition-opacity duration-1000", hasVideo && previewPlaying ? "opacity-0" : "opacity-100")}
          sizes="100vw"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-800 to-black" />
      )}

      {hasVideo && videoMode === "local" && localVideoUrl ? (
        <div className={cn("absolute inset-0 z-[1] overflow-hidden transition-opacity duration-1000", previewPlaying ? "opacity-100" : "opacity-0")}>
          <video
            ref={videoRef}
            src={localVideoUrl}
            autoPlay
            muted
            playsInline
            className="pointer-events-none absolute left-1/2 top-1/2 h-[56.25vw] min-h-full min-w-full w-[177.78vh] -translate-x-1/2 -translate-y-1/2 object-cover"
            onError={revertToPhoto}
            onEnded={() => {
              setPreviewPlaying(false);
              setShowVideo(false);
            }}
          />
        </div>
      ) : hasVideo && videoMode === "youtube" && trailerKey ? (
        <div className={cn("absolute inset-0 z-[1] overflow-hidden transition-opacity duration-1000", previewPlaying ? "opacity-100" : "opacity-0")}>
          <iframe
            ref={iframeRef}
            src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&enablejsapi=1&playsinline=1&modestbranding=1&rel=0&iv_load_policy=3&origin=${encodeURIComponent(origin)}`}
            className="pointer-events-none absolute left-1/2 top-1/2 h-[56.25vw] min-h-full min-w-full w-[177.78vh] -translate-x-1/2 -translate-y-1/2 scale-[1.35]"
            allow="autoplay; encrypted-media"
            title={`${heroItem.title} preview`}
            data-testid="hero-preview"
          />
        </div>
      ) : null}

      <div className="netflix-gradient-hero absolute inset-0 z-[2]" />
      <div className="netflix-gradient-bottom absolute inset-x-0 bottom-0 z-[2] h-48" />

      {heroError && (
        <div className="absolute left-4 right-4 top-20 z-20 flex items-start gap-2 rounded-md border border-yellow-500/40 bg-black/70 px-3 py-2 text-sm text-yellow-100 backdrop-blur md:left-12 md:max-w-xl">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
          <span>{heroError}</span>
        </div>
      )}

      {hasVideo && (
        <button
          type="button"
          onClick={() => setMuted(!muted)}
          className="absolute bottom-[28%] right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-white/40 bg-black/40 backdrop-blur md:right-12"
          aria-label={muted ? "Unmute preview" : "Mute preview"}
          data-testid="hero-mute"
        >
          {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </button>
      )}

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.5 }}
        className="absolute bottom-[18%] left-4 z-10 max-w-xl md:left-12 md:max-w-2xl lg:left-16 lg:max-w-3xl"
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={heroItem.title} className="mb-5 max-h-[22vh] w-auto max-w-[70vw] object-contain object-left drop-shadow-2xl md:max-w-[34vw]" data-testid="hero-logo" />
        ) : (
          <h1 className="mb-4 text-3xl font-bold leading-tight drop-shadow-lg md:text-5xl lg:text-6xl" data-testid="hero-title">
            {heroItem.title}
          </h1>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/90 md:text-base" data-testid="hero-meta">
          {year && <span>{year}</span>}
          {certification && <span className="rounded border border-white/50 px-1.5 text-xs leading-5">{certification}</span>}
          {runtime && <span>{runtime}</span>}
          {media === "tv" && <span>Series</span>}
          {genres.length > 0 && <span className="text-white/70">{genres.join(" · ")}</span>}
        </div>
        {heroItem.overview && (
          <p className="mb-5 line-clamp-3 max-w-lg text-sm text-white/90 drop-shadow md:text-base lg:text-lg">{heroItem.overview}</p>
        )}
        {heroProgress > 0 && heroProgress < 95 && (
          <div className="mb-3 h-1 max-w-xs overflow-hidden rounded bg-white/30">
            <div className="h-full bg-netflix-red" style={{ width: `${heroProgress}%` }} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={watchHref}
            className="flex items-center gap-2 rounded bg-white px-6 py-2 text-sm font-semibold text-black transition hover:bg-white/80 md:px-8 md:py-2.5 md:text-base"
            data-testid="hero-play"
          >
            <Play className="h-5 w-5 fill-current" />
            {playLabel}
          </Link>
          <button
            type="button"
            onClick={() => openDetail(heroItem)}
            className="flex items-center gap-2 rounded bg-white/25 px-6 py-2 text-sm font-semibold backdrop-blur transition hover:bg-white/20 md:px-8 md:py-2.5 md:text-base"
          >
            <Info className="h-5 w-5" />
            More Info
          </button>
          <button
            type="button"
            onClick={() => (inList ? removeFromMyList(heroItem.id) : addToMyList(heroItem.id))}
            className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white/60 bg-black/30 backdrop-blur transition hover:border-white md:h-11 md:w-11"
            aria-label={inList ? "Remove from My List" : "Add to My List"}
            title={inList ? "Remove from My List" : "Add to My List"}
            data-testid="hero-mylist"
          >
            {inList ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
          </button>
        </div>
      </motion.div>
    </section>
  );
}
