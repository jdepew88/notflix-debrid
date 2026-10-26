"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { TitleCardWithHover } from "@/components/browse/TitleCardWithHover";
import { CardGrid } from "@/components/browse/CardGrid";
import { findGenre, genreHref, GENRES, type GenreSort } from "@/lib/genres";
import { useAppStore } from "@/lib/store";
import { hasTmdb, type MediaItem } from "@/lib/types";
import { cn } from "@/lib/cn";

type Media = "all" | "movie" | "tv";

const SORTS: Array<{ value: GenreSort; label: string }> = [
  { value: "popularity", label: "Most popular" },
  { value: "release", label: "Newest" },
  { value: "rating", label: "Highest rated" },
  { value: "title", label: "A–Z" },
];

export function GenreContent() {
  const searchParams = useSearchParams();
  const genre = findGenre(searchParams.get("g")) ?? findGenre(searchParams.get("name"));
  const mediaParam = searchParams.get("media");
  const media: Media = mediaParam === "tv" || mediaParam === "movie" ? mediaParam : "all";
  const sortParam = searchParams.get("sort") as GenreSort | null;
  const sort: GenreSort = sortParam && SORTS.some((s) => s.value === sortParam) ? sortParam : "popularity";
  const settings = useAppStore((s) => s.settings);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalResults, setTotalResults] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const source = "tmdb" as const;
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const queryKey = `${genre?.slug ?? ""}|${media}|${sort}`;

  const loadPage = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!genre || loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/catalog?type=genre&g=${encodeURIComponent(genre.slug)}&media=${media}&sort=${sort}&page=${pageNum}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(
            res.status === 503
              ? "A TMDB API key is needed to browse genres. Add one in Settings."
              : data.error || `Could not load ${genre.name} (${res.status}).`
          );
          return;
        }
        const list = (data.items ?? []) as MediaItem[];
        setItems((prev) => {
          if (!append) return list;
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...list.filter((i) => !seen.has(i.id))];
        });
        setTotalPages(data.totalPages ?? 1);
        setTotalResults(typeof data.totalResults === "number" ? data.totalResults : null);
        setPage(pageNum);
      } catch {
        setError("Could not reach the server.");
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [genre, media, sort]
  );

  // A new genre/media/sort resets the grid before the load effect runs (derived-state pattern).
  const [activeQueryKey, setActiveQueryKey] = useState(queryKey);
  if (activeQueryKey !== queryKey) {
    setActiveQueryKey(queryKey);
    setItems([]);
    setPage(1);
    setTotalPages(1);
    setError(null);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!genre) {
        setLoading(false);
        return;
      }
      if (!hasTmdb(settings)) {
        if (cancelled) return;
        setError("The server owner needs to add a TMDB key in Settings → Metadata to browse genres.");
        setLoading(false);
        return;
      }
      await loadPage(1, false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, settings.tmdbConfigured]);

  useEffect(() => {
    if (source !== "tmdb") return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && page < totalPages && !loadingRef.current) void loadPage(page + 1, true);
      },
      { rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [page, totalPages, loadPage, source]);

  const queryHref = (patch: { media?: Media; sort?: GenreSort }) => {
    const params = new URLSearchParams({ g: genre?.slug ?? "" });
    const nextMedia = patch.media ?? media;
    const nextSort = patch.sort ?? sort;
    if (nextMedia !== "all") params.set("media", nextMedia);
    if (nextSort !== "popularity") params.set("sort", nextSort);
    return `/browse/genre?${params}`;
  };
  // Same page, new search params: the native History API is what Next's router syncs
  // `useSearchParams` from, with no server round-trip (router.replace re-resolves the static page).
  const setQuery = (patch: { media?: Media; sort?: GenreSort }) => {
    if (genre) window.history.replaceState(null, "", queryHref(patch));
  };

  if (!genre) {
    return (
      <div className="min-h-screen px-4 py-8 md:px-12 lg:px-16">
        <h1 className="mb-6 text-2xl font-semibold md:text-3xl">Browse by genre</h1>
        <div className="flex flex-wrap gap-2">
          {GENRES.map((g) => (
            <Link key={g.slug} href={genreHref(g)} className="rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/10">
              {g.name}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const showTvToggle = genre.tvId != null && genre.movieId != null && source === "tmdb";

  return (
    <div className="min-h-screen px-4 py-8 md:px-12 lg:px-16" data-testid="genre-page">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold md:text-3xl" data-testid="genre-title">{genre.name}</h1>
          <p className="mt-1 text-sm text-netflix-light-gray">
            {totalResults != null
                ? `${totalResults.toLocaleString()} ${media === "tv" ? "shows" : media === "movie" ? "films" : "films & shows"}`
                : genre.tvId == null
                  ? "Films"
                  : ""}
          </p>
        </div>
        {source === "tmdb" && (
          <div className="flex flex-wrap items-center gap-2">
            {showTvToggle && (
              <div className="flex rounded-full border border-white/20 p-0.5 text-sm" role="tablist" aria-label="Media type">
                {(["all", "movie", "tv"] as Media[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={media === m}
                    onClick={() => setQuery({ media: m })}
                    className={cn("rounded-full px-3 py-1", media === m ? "bg-white text-black" : "text-netflix-light-gray hover:text-white")}
                  >
                    {m === "all" ? "All" : m === "movie" ? "Films" : "TV"}
                  </button>
                ))}
              </div>
            )}
            <label className="text-sm text-netflix-light-gray">
              <span className="sr-only">Sort</span>
              <select
                value={sort}
                onChange={(e) => setQuery({ sort: e.target.value as GenreSort })}
                className="rounded-full border border-white/20 bg-black px-3 py-1.5 text-sm text-white"
                aria-label="Sort by"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded border border-yellow-500/30 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-100" data-testid="genre-error">
          {error}{" "}
          {error.includes("Settings") ? (
            <Link href="/settings" className="underline">Open Settings</Link>
          ) : (
            <button type="button" onClick={() => void loadPage(1, false)} className="underline">Try again</button>
          )}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="mb-8 text-netflix-light-gray" data-testid="genre-empty">No titles found for this genre.</p>
      )}

      <CardGrid testId="genre-grid">
        {items.map((item, i) => (
          <TitleCardWithHover key={`${item.id}-${i}`} item={item} layout="grid" priority={i < 4} />
        ))}
      </CardGrid>
      {source === "tmdb" && <div ref={sentinelRef} className="h-10" />}
      {loading && (
        <div className="flex justify-center py-8" data-testid="genre-loading">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
        </div>
      )}
      {!loading && source === "tmdb" && page >= totalPages && items.length > 0 && (
        <p className="py-6 text-center text-xs text-netflix-gray">You’ve reached the end.</p>
      )}
    </div>
  );
}
