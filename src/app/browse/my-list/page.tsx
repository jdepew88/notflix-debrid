"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { TitleCard } from "@/components/browse/TitleCard";
import { CARD_GRID_CLASS } from "@/components/browse/TitleCardWithHover";
import { CardGrid } from "@/components/browse/CardGrid";
import { getContinueWatchingItems, useAppStore } from "@/lib/store";
import { hasTmdb, type MediaItem } from "@/lib/types";

export default function MyListPage() {
  const storeSettings = useAppStore((s) => s.settings);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const myList = useAppStore((s) => (s.activeProfileId ? s.myListByProfile[s.activeProfileId] : undefined));
  // Re-render when this profile's progress changes (Continue Watching).
  useAppStore((s) => (s.activeProfileId ? s.lastWatchedByProfile[s.activeProfileId] : undefined));
  const [saved, setSaved] = useState<Record<string, MediaItem>>({});
  const [loading, setLoading] = useState(true);
  const ids = useMemo(() => myList ?? [], [myList]);

  // Saved titles: fetch their card data from TMDB (once per id).
  useEffect(() => {
    const missing = ids.filter((id) => id.startsWith("tmdb-") && !saved[id]);
    if (missing.length === 0 || !hasTmdb(storeSettings)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to fetch
      setLoading(false);
      return;
    }
    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += 60) chunks.push(missing.slice(i, i + 60));
    Promise.all(chunks.map((chunk) => fetch(`/api/catalog?type=lookup&ids=${chunk.join(",")}`).then((r) => (r.ok ? r.json() : { items: [] }))))
      .then((results) => {
        if (cancelled) return;
        const found: Record<string, MediaItem> = {};
        for (const r of results) for (const item of (r.items ?? []) as MediaItem[]) found[item.id] = item;
        setSaved((prev) => ({ ...prev, ...found }));
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ids, saved, storeSettings]);

  const byId = useMemo(() => new Map(Object.values(saved).map((i) => [i.id, i])), [saved]);
  // Most recently added first.
  const listItems = [...ids].reverse().map((id) => byId.get(id)).filter((x): x is MediaItem => Boolean(x));
  const continueItems = activeProfileId ? getContinueWatchingItems(Object.values(saved)) : [];

  return (
    <div className="min-h-screen px-4 pb-16 pt-8 md:px-12 lg:px-16">
      {continueItems.length > 0 && (
        <section className="mb-12" aria-labelledby="continue-heading">
          <h2 id="continue-heading" className="mb-4 text-xl font-semibold md:text-2xl">Continue Watching</h2>
          <CardGrid>
            {continueItems.map((item) => (
              <TitleCard key={item.id} item={item} />
            ))}
          </CardGrid>
        </section>
      )}

      <section aria-labelledby="mylist-heading">
        <h1 id="mylist-heading" className="mb-4 text-2xl font-semibold md:text-3xl">My List</h1>
        {listItems.length > 0 ? (
          <CardGrid testId="my-list-grid">
            {listItems.map((item, i) => (
              <TitleCard key={item.id} item={item} priority={i < 4} />
            ))}
          </CardGrid>
        ) : loading && ids.length > 0 ? (
          <div className={CARD_GRID_CLASS} aria-busy>
            {ids.slice(0, 8).map((id) => (
              <div key={id} className="aspect-video animate-pulse rounded-card bg-white/5" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-white/15 p-8 text-netflix-light-gray" data-testid="my-list-empty">
            <p className="text-lg text-white">Your list is empty</p>
            <p className="flex items-center gap-1.5 text-sm">
              Open any title and press <Plus className="inline h-4 w-4 rounded-full border border-white/50" /> to save it here.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
