"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getContinueWatchingItems, useAppStore, useActivePreferences } from "@/lib/store";
import {
  filterRowItems,
  getStreamingServiceLabel,
  getTmdbProviderId,
  STREAMING_FILTER_EXEMPT_ROW_IDS,
  type StreamingServiceFilterId,
} from "@/lib/streaming-services";
import {
  HOME_TMDB_ROWS_INITIAL,
  HOME_TMDB_ROWS_MORE,
  fetchHomeTmdbRow,
} from "@/lib/home-rows";
import { HeroBanner } from "@/components/browse/HeroBanner";
import { ContentRow } from "@/components/browse/ContentRow";
import { StreamingServiceFilterBar } from "@/components/browse/StreamingServiceFilterBar";
import { hasTmdb, type AppSettings, type MediaItem } from "@/lib/types";
import type { LastWatchedEntry } from "@/lib/watch-progress";

const EMPTY_IDS: string[] = [];
const EMPTY_WATCHED: Record<string, LastWatchedEntry> = {};

interface ContentRowData {
  id: string;
  title: string;
  items: MediaItem[];
  featured?: boolean;
}

/**
 * Featured title: the first trending film or series that has backdrop art and a synopsis (never a
 * Continue Watching leftover).
 */
function pickHero(rows: ContentRowData[] = []): MediaItem | null {
  const candidates = rows
    .filter((r) => !DEDUPE_EXEMPT_ROWS.has(r.id) && !r.id.startsWith("recommended-"))
    .flatMap((r) => r.items)
    .filter((i) => i.backdropPath && i.overview && i.overview.length > 40);
  return candidates[0] ?? rows.flatMap((r) => r.items)[0] ?? null;
}

/** Rows that may repeat titles shown elsewhere (they are the viewer's own lists). */
const DEDUPE_EXEMPT_ROWS = new Set(["continue-watching", "my-list"]);

/**
 * TMDB lists overlap heavily (a trending film is usually also popular and in its genre row). Keep
 * each title in the first row it appears in and drop rows left with too few titles to be useful.
 */
function dedupeRows(rows: ContentRowData[], minItems = 5): ContentRowData[] {
  const seen = new Set<string>();
  const out: ContentRowData[] = [];
  for (const row of rows) {
    if (DEDUPE_EXEMPT_ROWS.has(row.id)) {
      out.push(row);
      for (const item of row.items) seen.add(item.id);
      continue;
    }
    const items = row.items.filter((item) => !seen.has(item.id));
    if (items.length < Math.min(minItems, row.items.length)) continue;
    for (const item of items) seen.add(item.id);
    out.push(items.length === row.items.length ? row : { ...row, items });
  }
  return out;
}

function applyStreamingFilterToRows(
  rows: ContentRowData[],
  serviceId: StreamingServiceFilterId
): ContentRowData[] {
  if (serviceId === "all") return rows;

  return rows
    .map((row) => {
      if (STREAMING_FILTER_EXEMPT_ROW_IDS.has(row.id)) {
        return row;
      }
      return { ...row, items: filterRowItems(row.items, serviceId) };
    })
    .filter((row) => row.items.length > 0);
}

async function loadTmdbHomeRows(defs: typeof HOME_TMDB_ROWS_INITIAL, settings: AppSettings): Promise<ContentRowData[]> {
  const results = await Promise.all(defs.map((def) => fetchHomeTmdbRow(def, settings)));
  return results.filter((row): row is ContentRowData => Boolean(row));
}

export function BrowseContent() {
  const storeSettings = useAppStore((s) => s.settings);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const prefs = useActivePreferences();
  const myListIds = useAppStore((s) =>
    s.activeProfileId ? (s.myListByProfile[s.activeProfileId] ?? EMPTY_IDS) : EMPTY_IDS
  );
  const lastWatched = useAppStore((s) =>
    s.activeProfileId ? (s.lastWatchedByProfile[s.activeProfileId] ?? EMPTY_WATCHED) : EMPTY_WATCHED
  );
  const [recommendationRows, setRecommendationRows] = useState<ContentRowData[]>([]);
  const [allRows, setAllRows] = useState<ContentRowData[]>([]);
  const [hero, setHero] = useState<MediaItem | null>(null);
  const [heroVideoError, setHeroVideoError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTmdbRows, setLoadingTmdbRows] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [streamingFilter, setStreamingFilter] = useState<StreamingServiceFilterId>("all");
  const [providerRows, setProviderRows] = useState<ContentRowData[]>([]);
  const [loadingProvider, setLoadingProvider] = useState(false);
  const [moreRowIndex, setMoreRowIndex] = useState(0);
  const [moreRowsExhausted, setMoreRowsExhausted] = useState(false);
  const loadingMoreRef = useRef(false);
  const allRowsRef = useRef(allRows);
  allRowsRef.current = allRows;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadGenerationRef = useRef(0);

  const handleHeroItemChange = useCallback((item: MediaItem, error: string | null) => {
    setHero(item);
    setHeroVideoError(error);
  }, []);

  /** Continue Watching (this profile's progress, kept on the server) above the catalog rows. */
  const withContinueWatching = useCallback((rows: ContentRowData[]): ContentRowData[] => {
    const continueItems = getContinueWatchingItems([]);
    return continueItems.length > 0 ? [{ id: "continue-watching", title: "Continue Watching", items: continueItems }, ...rows] : rows;
  }, []);

  const loadBrowse = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    if (allRowsRef.current.length === 0) setLoading(true);
    setLoadFailed(false);
    setStreamingFilter("all");
    setMoreRowIndex(0);
    setMoreRowsExhausted(false);

    // Personal rows render at once; the catalog follows.
    const personal = withContinueWatching([]);
    setAllRows(personal);
    if (!hasTmdb(storeSettings)) {
      setLoading(false);
      return;
    }
    setLoading(personal.length === 0);
    setLoadingTmdbRows(true);
    try {
      const tmdbRows = await loadTmdbHomeRows(HOME_TMDB_ROWS_INITIAL, storeSettings);
      if (generation !== loadGenerationRef.current) return;
      if (tmdbRows.length === 0) setLoadFailed(true);
      const rows = withContinueWatching(tmdbRows);
      setAllRows(rows);
      setHero(pickHero(rows));
    } catch {
      if (generation === loadGenerationRef.current) setLoadFailed(true);
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setLoadingTmdbRows(false);
      }
    }
  }, [storeSettings, withContinueWatching]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
    void loadBrowse();
  }, [loadBrowse, activeProfileId]);

  useEffect(() => {
    if (streamingFilter === "all") {
      setProviderRows([]);
      setLoadingProvider(false);
      return;
    }

    const providerId = getTmdbProviderId(streamingFilter);
    if (!hasTmdb(storeSettings) || !providerId) {
      setProviderRows([]);
      return;
    }

    let cancelled = false;
    const label = getStreamingServiceLabel(streamingFilter);

    async function loadProviderCatalog() {
      setLoadingProvider(true);
      try {
        const [moviesRes, tvRes] = await Promise.all([
          fetch(`/api/catalog?type=discover_provider&providerId=${providerId}&media=movie`, { credentials: "same-origin" }),
          fetch(`/api/catalog?type=discover_provider&providerId=${providerId}&media=tv`, { credentials: "same-origin" }),
        ]);

        if (cancelled) return;

        const rows: ContentRowData[] = [];
        if (moviesRes.ok) {
          const data = await moviesRes.json();
          if (data.items?.length) {
            rows.push({
              id: `provider-${streamingFilter}-movies`,
              title: `Movies on ${label}`,
              items: data.items as MediaItem[],
            });
          }
        }
        if (tvRes.ok) {
          const data = await tvRes.json();
          if (data.items?.length) {
            rows.push({
              id: `provider-${streamingFilter}-tv`,
              title: `TV on ${label}`,
              items: data.items as MediaItem[],
            });
          }
        }
        setProviderRows(rows);
      } catch {
        if (!cancelled) setProviderRows([]);
      } finally {
        if (!cancelled) setLoadingProvider(false);
      }
    }

    void loadProviderCatalog();
    return () => {
      cancelled = true;
    };
  }, [streamingFilter, storeSettings]);

  const loadMoreRows = useCallback(async () => {
    if (loadingMoreRef.current || moreRowsExhausted) return;

    if (!hasTmdb(storeSettings)) {
      setMoreRowsExhausted(true);
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const batchSize = 3;
      let index = moreRowIndex;
      let added = 0;

      while (index < HOME_TMDB_ROWS_MORE.length && added < batchSize) {
        const def = HOME_TMDB_ROWS_MORE[index];
        index += 1;
        const row = await fetchHomeTmdbRow(def, storeSettings);
        if (row) {
          setAllRows((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            return [...prev, row];
          });
          added += 1;
        }
      }

      setMoreRowIndex(index);
      if (index >= HOME_TMDB_ROWS_MORE.length) {
        setMoreRowsExhausted(true);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [moreRowIndex, moreRowsExhausted, storeSettings]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loading || moreRowsExhausted || streamingFilter !== "all") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void loadMoreRows();
      },
      { rootMargin: "400px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, moreRowsExhausted, loadMoreRows, streamingFilter]);

  // "Because you watched …": TMDB recommendations seeded by the two most recent titles.
  const recommendationSeeds = useMemo(
    () =>
      Object.values(lastWatched)
        .filter((e) => e.item?.tmdbId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((e, i, all) => all.findIndex((x) => x.item?.tmdbId === e.item?.tmdbId) === i)
        .slice(0, 2)
        .map((e) => e.item!),
    [lastWatched]
  );
  const seedKey = recommendationSeeds.map((s) => `${s.mediaType ?? s.type}:${s.tmdbId}`).join(",");

  const recommendationsEnabled = hasTmdb(storeSettings) && recommendationSeeds.length > 0;

  useEffect(() => {
    if (!recommendationsEnabled) return;
    let cancelled = false;
    void Promise.all(
      recommendationSeeds.map(async (seed) => {
        const media = seed.mediaType === "tv" || seed.type === "series" || seed.type === "episode" ? "tv" : "movie";
        const res = await fetch(`/api/catalog?type=recommendations&id=${seed.tmdbId}&media=${media}`).catch(() => null);
        if (!res?.ok) return null;
        const data = await res.json();
        const items = (data.items ?? []) as MediaItem[];
        return items.length ? { id: `recommended-${media}-${seed.tmdbId}`, title: `Because you watched ${seed.title}`, items } : null;
      })
    ).then((rows) => {
      if (!cancelled) setRecommendationRows(rows.filter((r): r is ContentRowData => Boolean(r)));
    });
    return () => {
      cancelled = true;
    };
    // seedKey captures the seeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, recommendationsEnabled]);

  const myListRow = useMemo<ContentRowData | null>(() => {
    if (myListIds.length === 0) return null;
    const byId = new Map(allRows.flatMap((r) => r.items).map((i) => [i.id, i] as const));
    const items = myListIds.map((id) => byId.get(id)).filter((i): i is MediaItem => Boolean(i));
    return items.length ? { id: "my-list", title: "My List", items } : null;
  }, [myListIds, allRows]);

  const filteredRows = useMemo(() => {
    if (streamingFilter === "all") {
      const rows = applyStreamingFilterToRows(allRows, "all");
      const continueIdx = rows.findIndex((r) => r.id === "continue-watching");
      const personal = [myListRow, ...(recommendationsEnabled ? recommendationRows : [])].filter((r): r is ContentRowData => Boolean(r));
      if (personal.length === 0) return dedupeRows(rows);
      const at = continueIdx >= 0 ? continueIdx + 1 : Math.min(1, rows.length);
      return dedupeRows([...rows.slice(0, at), ...personal, ...rows.slice(at)]);
    }

    const continueRow = allRows.find((row) => row.id === "continue-watching");
    const rows = [...providerRows];
    if (continueRow) rows.unshift(continueRow);
    return rows;
  }, [allRows, streamingFilter, providerRows, myListRow, recommendationRows, recommendationsEnabled]);

  const displayHero = useMemo(() => {
    if (streamingFilter === "all") return hero;
    const firstMovie = providerRows
      .flatMap((row) => row.items)
      .find((item) => item.type === "movie");
    return firstMovie ?? providerRows[0]?.items[0] ?? null;
  }, [hero, streamingFilter, providerRows]);

  const settings = storeSettings;
  const filterActive = streamingFilter !== "all";
  const filterEmpty =
    filterActive && !loadingProvider && filteredRows.length === 0;
  const showStreamingFilters =
    hasTmdb(settings) && (allRows.length > 0 || filterActive);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {displayHero && (
        <HeroBanner
          item={displayHero}
          videoError={heroVideoError}
          onHeroItemChange={handleHeroItemChange}
          autoplayPreviews={prefs.autoplayPreviews}
        />
      )}
      <div className={displayHero ? "-mt-24 relative z-10 md:-mt-32" : "pt-4"}>
        {showStreamingFilters && (
          <StreamingServiceFilterBar
            active={streamingFilter}
            onChange={setStreamingFilter}
          />
        )}

        {filterActive && loadingProvider ? (
          <div className="flex justify-center py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
          </div>
        ) : filterEmpty ? (
          <div className="flex flex-col items-center justify-center px-4 py-16 text-center md:px-12">
            <p className="text-lg font-medium text-white">
              No titles on {getStreamingServiceLabel(streamingFilter)}
            </p>
            <p className="mt-2 max-w-md text-sm text-netflix-light-gray">
              Try another service or choose All. Titles need TMDB streaming data — add a TMDB API
              key in Settings if provider logos are missing.
            </p>
            <button
              type="button"
              onClick={() => setStreamingFilter("all")}
              className="mt-6 rounded bg-white px-6 py-2 text-sm font-semibold text-black hover:bg-white/80"
            >
              Show All
            </button>
          </div>
        ) : (
          filteredRows.map((row) => (
            <ContentRow
              key={row.id}
              title={row.title}
              items={row.items}
              featured={row.featured}
            />
          ))
        )}

        {loadingTmdbRows && streamingFilter === "all" && !filterEmpty && (
          <div className="flex items-center justify-center gap-3 py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
            <p className="text-sm text-netflix-light-gray">Loading trending &amp; popular rows…</p>
          </div>
        )}

        {allRows.length === 0 && (
          <div className="flex flex-col items-center justify-center px-4 py-24 text-center">
            {hasTmdb(settings) && loadFailed ? (
              <>
                <h2 className="mb-4 text-2xl font-semibold">Could not load the catalog</h2>
                <p className="max-w-lg text-netflix-light-gray">
                  TMDB did not answer. Check this server&apos;s internet connection, or ask the server owner to re-check the
                  TMDB key in Settings → Metadata.
                </p>
                <button
                  type="button"
                  onClick={() => void loadBrowse()}
                  className="mt-6 rounded bg-netflix-red px-6 py-2 font-semibold hover:bg-netflix-red-hover"
                >
                  Try again
                </button>
              </>
            ) : (
              <>
                <h2 className="mb-4 text-2xl font-semibold">Nothing to browse yet</h2>
                <p className="max-w-lg text-netflix-light-gray">
                  The catalog comes from TMDB. The server owner can add a TMDB key in Settings → Metadata.
                </p>
              </>
            )}
          </div>
        )}

        {!filterEmpty && hasTmdb(settings) && !moreRowsExhausted && (
          <div ref={sentinelRef} className="flex justify-center py-8">
            {loadingMore && (
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
            )}
          </div>
        )}

      </div>
    </div>
  );
}
