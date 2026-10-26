"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Clapperboard, Loader2, Play, Plus, ServerCrash, Volume2, VolumeX, X, Zap } from "lucide-react";
import { MediaImage } from "@/components/ui/MediaImage";
import { Dialog } from "@/components/ui/Dialog";
import { useDetailModal } from "@/providers/DetailModalProvider";
import { useActivePreferences, useAppStore } from "@/lib/store";
import { backdropUrl, logoUrl, posterUrl } from "@/lib/tmdb";
import { TitleCardWithHover } from "./TitleCardWithHover";
import type { SeasonEpisode, TitleDetails, TitlePerson } from "@/lib/tmdb";
import { playHrefForItem, playLabelForItem } from "@/lib/playback";
import { isSeriesItem, watchHrefForEpisode, watchIdForItem } from "@/lib/watch-url";
import { episodeProgressKey } from "@/lib/watch-progress";
import type { MediaItem } from "@/lib/types";
import { cn } from "@/lib/cn";

/**
 * Title details: opened by clicking a poster anywhere (rows, genre grid, search, My List). Playback
 * starts only from an explicit Play button here (or an episode's Play).
 */
export function DetailModal() {
  const { open, item } = useDetailModal();
  if (!open || !item) return null;
  // Keyed per title: opening a recommendation starts from a clean state.
  return <TitleDetailsDialog key={item.id} item={item} />;
}

type Status = "loading" | "ready" | "restricted" | "error" | "basic";

function tmdbIdOf(item: MediaItem): number | null {
  if (item.tmdbId) return item.tmdbId;
  const m = item.id.match(/^tmdb-(?:tv-)?(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function formatRuntime(minutes?: number): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Defined fields of `b` over `a` (a library item keeps its own id/source; TMDB fills the rest). */
function merge(a: MediaItem, b: MediaItem): MediaItem {
  const defined = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return { ...a, ...defined } as MediaItem;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

function TitleDetailsDialog({ item }: { item: MediaItem }) {
  const router = useRouter();
  const titleId = useId();
  const { closeDetail, openDetail, rememberForReturn } = useDetailModal();
  const prefs = useActivePreferences();
  const reducedMotion = useReducedMotion();
  const tmdbId = tmdbIdOf(item);
  const media: "movie" | "tv" = isSeriesItem(item) || item.mediaType === "tv" ? "tv" : "movie";

  const [data, setData] = useState<TitleDetails | null>(null);
  const [status, setStatus] = useState<Status>(tmdbId ? "loading" : "basic");
  const [trailer, setTrailer] = useState<"none" | "preview" | "full">("none");
  const [muted, setMuted] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tmdbId) return;
    const controller = new AbortController();
    fetch(`/api/catalog?type=title&id=${tmdbId}&media=${media}`, { signal: controller.signal })
      .then(async (res) => {
        if (res.status === 403) return setStatus("restricted");
        if (!res.ok) return setStatus("error");
        setData(await res.json());
        setStatus("ready");
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setStatus("error");
      });
    return () => controller.abort();
  }, [tmdbId, media]);

  const display = useMemo(() => (data ? merge(data.item, item) : item), [data, item]);
  const trailerKey = data?.trailerKey ?? null;
  const isSeries = media === "tv";

  // Optional muted preview, only when the profile enabled autoplaying previews.
  useEffect(() => {
    if (!trailerKey || !prefs.autoplayPreviews || reducedMotion || trailer !== "none") return;
    const t = setTimeout(() => setTrailer((v) => (v === "none" ? "preview" : v)), 1500);
    return () => clearTimeout(t);
    // Only when the trailer key arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailerKey, prefs.autoplayPreviews, reducedMotion]);

  const ytCommand = useCallback((func: string) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "https://www.youtube.com");
  }, []);

  const myListIds = useAppStore((s) => (s.activeProfileId ? s.myListByProfile[s.activeProfileId] : undefined));
  const addToMyList = useAppStore((s) => s.addToMyList);
  const removeFromMyList = useAppStore((s) => s.removeFromMyList);
  const inList = Boolean(myListIds?.includes(display.id));

  const play = (href: string) => {
    rememberForReturn(display);
    router.push(href);
  };

  // w1280 covers the dialog (max 1100 px) without fetching multi-megabyte originals.
  const backdrop = backdropUrl(display.backdropPath, "w1280") ?? posterUrl(display.posterPath, "w780");
  const logo = logoUrl(data?.logoPath, "w500");
  const year = data?.year ?? display.releaseDate?.slice(0, 4);
  const runtime = isSeries
    ? data?.numberOfSeasons
      ? `${data.numberOfSeasons} Season${data.numberOfSeasons === 1 ? "" : "s"}`
      : null
    : formatRuntime(display.runtime);
  const people = isSeries ? data?.creators ?? [] : data?.directors ?? [];
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <Dialog
      open
      onClose={() => (trailer === "full" ? setTrailer("none") : closeDetail())}
      labelledBy={titleId}
      testId="title-details"
      overlayClassName="sm:px-6 sm:py-10"
      className="mx-auto min-h-full w-full animate-rise-in overflow-hidden bg-[#141414] shadow-[0_30px_80px_rgba(0,0,0,0.7)] sm:min-h-0 sm:max-w-[1100px] sm:rounded-xl sm:ring-1 sm:ring-white/10"
    >
      <div ref={scrollRef}>
        {/* Hero */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-zinc-900 sm:aspect-[16/8]">
          {backdrop && (
            <MediaImage
              src={backdrop}
              alt=""
              fill
              priority
              sizes="(max-width: 1100px) 100vw, 1100px"
              className={cn("object-cover transition-opacity duration-700", !reducedMotion && "animate-ken-burns", trailer === "preview" && "opacity-0")}
            />
          )}
          {trailer === "preview" && trailerKey && (
            // Oversized and clipped so YouTube's own title bar and branding stay out of view.
            <iframe
              ref={iframeRef}
              title={`${display.title} trailer preview`}
              src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&enablejsapi=1&playsinline=1&modestbranding=1&rel=0&iv_load_policy=3&loop=1&playlist=${trailerKey}&origin=${encodeURIComponent(origin)}`}
              allow="autoplay; encrypted-media"
              tabIndex={-1}
              className="pointer-events-none absolute left-1/2 top-1/2 h-[150%] w-[150%] -translate-x-1/2 -translate-y-1/2"
              data-testid="details-preview"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-[#141414]/40 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#141414]/90 via-[#141414]/30 to-transparent" />

          <button
            type="button"
            onClick={closeDetail}
            aria-label="Close details"
            data-testid="details-close"
            className="absolute right-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/70 ring-1 ring-white/25 backdrop-blur hover:bg-black hover:ring-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:right-4 sm:top-4"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="absolute inset-x-0 bottom-0 z-10 px-5 pb-6 sm:px-10 sm:pb-9">
            <h2 id={titleId} className="mb-3 max-w-[70%] sm:mb-5">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- transparent PNG logo, sized by CSS
                <img src={logo} alt={display.title} className="max-h-[72px] w-auto max-w-full object-contain object-left drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)] sm:max-h-[130px]" />
              ) : (
                <span className="block text-3xl font-extrabold leading-tight drop-shadow-lg sm:text-5xl">{display.title}</span>
              )}
            </h2>
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
              <button
                type="button"
                data-autofocus
                onClick={() => play(playHrefForItem(display))}
                data-testid="details-play"
                className="flex items-center gap-2 rounded-md bg-white px-6 py-2.5 text-base font-semibold text-black transition hover:bg-white/80 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50 sm:px-8 sm:text-lg"
              >
                <Play className="h-6 w-6 fill-current" />
                {playLabelForItem(display)}
              </button>
              <button
                type="button"
                onClick={() => (inList ? removeFromMyList(display.id) : addToMyList(display.id))}
                aria-pressed={inList}
                aria-label={inList ? "Remove from My List" : "Add to My List"}
                title={inList ? "Remove from My List" : "Add to My List"}
                data-testid="details-mylist"
                className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-white/60 bg-black/40 transition hover:border-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {inList ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
              </button>
              {trailerKey && (
                <button
                  type="button"
                  onClick={() => setTrailer("full")}
                  data-testid="details-trailer"
                  className="flex items-center gap-2 rounded-md bg-white/15 px-4 py-2.5 text-sm font-semibold backdrop-blur transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <Clapperboard className="h-5 w-5" /> Trailer
                </button>
              )}
              {trailer === "preview" && (
                <button
                  type="button"
                  onClick={() => {
                    ytCommand(muted ? "unMute" : "mute");
                    setMuted(!muted);
                  }}
                  aria-label={muted ? "Unmute preview" : "Mute preview"}
                  className="ml-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/50 bg-black/40 hover:border-white"
                >
                  {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </button>
              )}
            </div>
          </div>

          {trailer === "full" && trailerKey && (
            <div className="absolute inset-0 z-30 flex flex-col bg-black" data-testid="details-trailer-player">
              <div className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="truncate text-netflix-light-gray">Trailer · {display.title}</span>
                <button type="button" onClick={() => setTrailer("none")} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10">
                  <X className="h-4 w-4" /> Close trailer
                </button>
              </div>
              <iframe
                title={`${display.title} trailer`}
                src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&playsinline=1&modestbranding=1&rel=0&origin=${encodeURIComponent(origin)}`}
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                className="w-full flex-1"
              />
            </div>
          )}
        </div>

        {/* Body */}
        <div className="px-5 pb-8 sm:px-10">
          {status === "restricted" && (
            <p className="mb-6 rounded-md bg-amber-500/10 px-4 py-3 text-sm text-amber-200 ring-1 ring-amber-500/30" role="alert">
              This title isn&apos;t available on this profile.
            </p>
          )}
          {status === "error" && (
            <p className="mb-6 flex items-center gap-2 text-sm text-netflix-light-gray">
              <ServerCrash className="h-4 w-4" /> Some details couldn&apos;t be loaded.
            </p>
          )}

          <div className="grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div>
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-white/90" data-testid="details-meta">
                {display.rating != null && display.rating > 0 && (
                  <span className="font-semibold text-green-400" title="TMDB user rating">★ {display.rating.toFixed(1)}</span>
                )}
                {year && <span>{year}</span>}
                {display.certification && (
                  <span className="rounded-sm border border-white/50 px-1.5 py-px text-xs font-medium" data-testid="details-certification">
                    {display.certification}
                  </span>
                )}
                {runtime && <span>{runtime}</span>}
                <span className="rounded-sm border border-white/30 px-1 text-[10px] font-semibold text-white/80">HD</span>
              </div>
              {status === "loading" ? (
                <div className="space-y-2" aria-busy>
                  <div className="h-4 w-11/12 animate-pulse rounded bg-white/10" />
                  <div className="h-4 w-10/12 animate-pulse rounded bg-white/10" />
                  <div className="h-4 w-7/12 animate-pulse rounded bg-white/10" />
                </div>
              ) : (
                <>
                  {data?.tagline && <p className="mb-2 text-base italic text-white/70">{data.tagline}</p>}
                  {display.overview && <p className="text-[15px] leading-relaxed text-white sm:text-base" data-testid="details-overview">{display.overview}</p>}
                </>
              )}
              {status !== "restricted" && <Availability item={display} media={media} />}
            </div>

            <dl className="space-y-3 text-sm">
              {data && data.cast.length > 0 && (
                <div>
                  <dt className="inline text-netflix-gray">Cast: </dt>
                  <dd className="inline text-white/90">{data.cast.slice(0, 5).map((c) => c.name).join(", ")}</dd>
                </div>
              )}
              {people.length > 0 && (
                <div>
                  <dt className="inline text-netflix-gray">{isSeries ? "Created by: " : people.length > 1 ? "Directors: " : "Director: "}</dt>
                  <dd className="inline text-white/90" data-testid="details-director">{people.map((p) => p.name).join(", ")}</dd>
                </div>
              )}
              {display.genres && display.genres.length > 0 && (
                <div>
                  <dt className="inline text-netflix-gray">Genres: </dt>
                  <dd className="inline text-white/90">{display.genres.join(", ")}</dd>
                </div>
              )}
              {display.certification && (
                <div>
                  <dt className="inline text-netflix-gray">Maturity rating: </dt>
                  <dd className="inline text-white/90">{display.certification} (US)</dd>
                </div>
              )}
            </dl>
          </div>

          {isSeries && tmdbId && data && data.seasons.length > 0 && (
            <Episodes
              tmdbId={tmdbId}
              seasons={data.seasons}
              seriesWatchId={watchIdForItem(display)}
              title={display.title}
              onPlay={(season, episode) =>
                play(watchHrefForEpisode({ watchId: watchIdForItem(display), tmdbId, title: display.title, season, episode }))
              }
            />
          )}

          {data && data.cast.length > 0 && <Cast people={data.cast} />}

          {data && data.recommendations.length > 0 && (
            <section className="mt-10" aria-labelledby={`${titleId}-more`}>
              <h3 id={`${titleId}-more`} className="mb-4 text-xl font-semibold">More like this</h3>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4" data-testid="details-recommendations">
                {data.recommendations.slice(0, 12).map((rec) => (
                  <li key={rec.id}>
                    <TitleCardWithHover item={rec} layout="grid" hoverPreview={false} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Real-Debrid availability on request only (a release search is not free, so never on hover/scroll). */
function Availability({ item, media }: { item: MediaItem; media: "movie" | "tv" }) {
  const [state, setState] = useState<{ status: "idle" | "checking" | "done" | "error"; text?: string; ok?: boolean }>({ status: "idle" });
  const tmdbId = tmdbIdOf(item);
  if (!tmdbId) return null;

  const check = async () => {
    setState({ status: "checking" });
    const params = new URLSearchParams({ tmdbId: String(tmdbId), type: media === "tv" ? "series" : "movie", title: item.title, hevc: "1" });
    if (media === "tv") {
      params.set("season", "1");
      params.set("episode", "1");
    }
    try {
      const res = await fetch(`/api/playback/sources?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ status: "error", text: data.code === "debrid-not-configured" ? "Real-Debrid isn't set up on this server." : data.error ?? "Couldn't check right now." });
        return;
      }
      const candidates = (data.candidates ?? []) as Array<{ cached: boolean; quality?: string }>;
      const cached = candidates.filter((c) => c.cached);
      const order = ["2160p", "4K", "1440p", "1080p", "720p", "480p"];
      const best = cached.map((c) => c.quality ?? "").sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
      setState(
        cached.length
          ? { status: "done", ok: true, text: `Ready to stream on Real-Debrid — ${cached.length} release${cached.length === 1 ? "" : "s"}${best ? `, up to ${best}` : ""}${media === "tv" ? " (S1 E1)" : ""}.` }
          : { status: "done", ok: false, text: candidates.length ? `Found ${candidates.length} release${candidates.length === 1 ? "" : "s"}, none cached yet — playback may need to wait for a download.` : "No releases found on Real-Debrid." }
      );
    } catch {
      setState({ status: "error", text: "Couldn't reach Notflix." });
    }
  };

  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 text-sm" data-testid="details-availability">
      {state.status === "idle" || state.status === "error" ? (
        <button type="button" onClick={() => void check()} className="flex items-center gap-2 rounded-full border border-white/25 px-3.5 py-1.5 text-white/85 hover:border-white hover:text-white">
          <Zap className="h-4 w-4" /> Check Real-Debrid availability
        </button>
      ) : null}
      {state.status === "checking" && (
        <span className="flex items-center gap-2 text-netflix-light-gray" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking releases…
        </span>
      )}
      {state.text && (
        <span role="status" className={cn(state.ok ? "text-green-400" : state.status === "error" ? "text-amber-300" : "text-netflix-light-gray")}>
          {state.text}
        </span>
      )}
    </div>
  );
}

function Cast({ people }: { people: TitlePerson[] }) {
  return (
    <section className="mt-10" aria-label="Cast">
      <h3 className="mb-4 text-xl font-semibold">Cast</h3>
      <ul className="flex gap-4 overflow-x-auto pb-2 row-scroll">
        {people.slice(0, 12).map((p) => (
          <li key={`${p.name}-${p.role}`} className="w-[92px] shrink-0 text-center">
            <div className="relative mx-auto h-[72px] w-[72px] overflow-hidden rounded-full bg-zinc-800">
              {p.profilePath ? (
                <MediaImage src={`https://image.tmdb.org/t/p/w185${p.profilePath}`} alt="" fill sizes="72px" className="object-cover" />
              ) : (
                <span className="flex h-full items-center justify-center text-lg text-white/40">{p.name.charAt(0)}</span>
              )}
            </div>
            <p className="mt-2 line-clamp-2 text-xs font-medium">{p.name}</p>
            {p.role && <p className="line-clamp-2 text-[11px] text-netflix-gray">{p.role}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Episodes({
  tmdbId,
  seasons,
  seriesWatchId,
  title,
  onPlay,
}: {
  tmdbId: number;
  seasons: TitleDetails["seasons"];
  seriesWatchId: string;
  title: string;
  onPlay: (season: number, episode: number) => void;
}) {
  const last = useAppStore((s) => (s.activeProfileId ? s.lastWatchedByProfile[s.activeProfileId]?.[seriesWatchId] : undefined));
  const progress = useAppStore((s) => (s.activeProfileId ? s.continueWatchingByProfile[s.activeProfileId] : undefined));
  const initial = last?.season && seasons.some((s) => s.season === last.season) ? last.season : seasons[0].season;
  const [season, setSeason] = useState(initial);
  const [episodes, setEpisodes] = useState<SeasonEpisode[] | null>(null);
  const [error, setError] = useState(false);
  const selectId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/catalog?type=season&id=${tmdbId}&season=${season}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setEpisodes(data.episodes ?? []);
        setError(false);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setError(true);
      });
    return () => controller.abort();
  }, [tmdbId, season]);

  const current = seasons.find((s) => s.season === season);

  return (
    <section className="mt-10" aria-labelledby={`${selectId}-h`} data-testid="details-episodes">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 id={`${selectId}-h`} className="text-xl font-semibold">Episodes</h3>
        {seasons.length > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Season</span>
            <select
              id={selectId}
              value={season}
              onChange={(e) => {
                setEpisodes(null);
                setSeason(Number(e.target.value));
              }}
              data-testid="season-select"
              className="rounded-md border border-white/25 bg-[#242424] px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-white/60"
            >
              {seasons.map((s) => (
                <option key={s.season} value={s.season}>
                  {s.name || `Season ${s.season}`} ({s.episodeCount} episodes)
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-sm text-netflix-light-gray">{current?.name}</span>
        )}
      </div>

      {error && <p className="text-sm text-netflix-light-gray">Episodes couldn&apos;t be loaded.</p>}
      {!episodes && !error && (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-md bg-white/5" />
          ))}
        </div>
      )}
      {episodes && (
        <ol className="divide-y divide-white/10 border-y border-white/10">
          {episodes.map((ep) => {
            const pct = progress?.[episodeProgressKey(seriesWatchId, ep.season, ep.episode)] ?? 0;
            const isCurrent = last?.season === ep.season && last?.episode === ep.episode;
            return (
              <li key={ep.episode}>
                <button
                  type="button"
                  onClick={() => onPlay(ep.season, ep.episode)}
                  data-testid="episode"
                  data-season={ep.season}
                  data-episode={ep.episode}
                  aria-label={`Play ${title} season ${ep.season} episode ${ep.episode}: ${ep.name}`}
                  className={cn(
                    "group flex w-full items-start gap-4 px-2 py-4 text-left transition hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none sm:px-4",
                    isCurrent && "bg-white/[0.04]"
                  )}
                >
                  <span className="hidden w-6 shrink-0 pt-8 text-center text-xl text-netflix-light-gray sm:block">{ep.episode}</span>
                  <span className="relative aspect-video w-32 shrink-0 overflow-hidden rounded bg-zinc-800 sm:w-40">
                    {ep.stillPath && (
                      <MediaImage src={`https://image.tmdb.org/t/p/w300${ep.stillPath}`} alt="" fill sizes="160px" className="object-cover" />
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white bg-black/50">
                        <Play className="h-5 w-5 fill-current" />
                      </span>
                    </span>
                    {pct > 0 && (
                      <span className="absolute inset-x-0 bottom-0 h-1 bg-white/30">
                        <span className="block h-full bg-netflix-red" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">
                        <span className="sm:hidden">{ep.episode}. </span>
                        {ep.name}
                      </span>
                      {ep.runtime ? <span className="shrink-0 text-sm text-netflix-light-gray">{ep.runtime}m</span> : null}
                    </span>
                    {ep.overview && <span className="mt-1 line-clamp-3 block text-sm text-netflix-light-gray">{ep.overview}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
