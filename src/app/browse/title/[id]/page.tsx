"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MediaImage } from "@/components/ui/MediaImage";
import { useParams, useRouter } from "next/navigation";
import { Play, Plus, Check, ArrowLeft, ListVideo } from "lucide-react";
import { posterUrl, backdropUrl } from "@/lib/tmdb";
import {
  isSeriesItem,
  watchHrefForEpisode,
  watchHrefForItem,
  watchIdForItem,
} from "@/lib/watch-url";
import { EpisodeBrowser } from "@/components/player/EpisodeBrowser";
import { useAppStore, isInMyList } from "@/lib/store";
import type { MediaItem } from "@/lib/types";

export default function TitleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = decodeURIComponent(params.id as string);
  const [item, setItem] = useState<MediaItem | null>(null);
  const addToMyList = useAppStore((s) => s.addToMyList);
  const removeFromMyList = useAppStore((s) => s.removeFromMyList);
  const inList = isInMyList(id);

  useEffect(() => {
    async function load() {
      if (id.startsWith("debrid-")) {
        setItem({
          id,
          title: "Debrid Content",
          type: "movie",
          source: "debrid",
          debridId: id.replace("debrid-", ""),
        });
        return;
      }
      const res = await fetch(`/api/catalog?type=search&q=${encodeURIComponent(id.replace("tmdb-", ""))}`);
      if (res.ok) {
        const data = await res.json();
        const found = (data.items ?? []).find((i: MediaItem) => i.id === id);
        setItem(found ?? null);
      }
    }
    load();
  }, [id]);

  if (!item) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      </div>
    );
  }

  const backdrop = backdropUrl(item.backdropPath);
  const poster = posterUrl(item.posterPath, "w500");
  const isSeries = isSeriesItem(item);

  return (
    <div className="min-h-screen">
      <div className="relative h-[50vh] min-h-[300px] w-full md:min-h-[400px]">
        {backdrop ? (
          <MediaImage src={backdrop} alt="" fill className="object-cover" priority sizes="100vw" />
        ) : (
          <div className="absolute inset-0 bg-zinc-900" />
        )}
        <div className="netflix-gradient-hero absolute inset-0" />
        <div className="netflix-gradient-bottom absolute inset-x-0 bottom-0 h-32" />

        <Link
          href="/browse"
          className="absolute left-4 top-4 flex items-center gap-2 text-sm hover:underline md:left-12"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <div className="relative -mt-32 px-4 pb-12 md:-mt-40 md:px-12 lg:px-16">
        <div className="flex flex-col gap-6 md:flex-row md:gap-8">
          {poster && (
            <div className="relative hidden h-48 w-32 shrink-0 overflow-hidden rounded shadow-lg md:block md:h-64 md:w-44 lg:h-72 lg:w-48">
              <MediaImage src={poster} alt={item.title} fill className="object-cover" sizes="192px" />
            </div>
          )}
          <div className="flex-1">
            <h1 className="mb-2 text-3xl font-bold md:text-4xl lg:text-5xl">{item.title}</h1>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-netflix-light-gray">
              {item.releaseDate && <span>{item.releaseDate.slice(0, 4)}</span>}
              {item.rating && <span>{item.rating.toFixed(1)} Rating</span>}
              {item.source === "debrid" && <span className="rounded border border-white/30 px-2 py-0.5">Real-Debrid</span>}
            </div>

            <div className="mb-6 flex flex-wrap gap-3">
              {isSeries ? (
                <a
                  href="#episodes"
                  className="flex items-center gap-2 rounded bg-white px-6 py-2.5 font-semibold text-black hover:bg-white/80"
                >
                  <ListVideo className="h-5 w-5" />
                  Episodes
                </a>
              ) : (
                <Link
                  href={watchHrefForItem(item)}
                  className="flex items-center gap-2 rounded bg-white px-6 py-2.5 font-semibold text-black hover:bg-white/80"
                >
                  <Play className="h-5 w-5 fill-current" />
                  Play
                </Link>
              )}
              <button
                type="button"
                onClick={() => (inList ? removeFromMyList(id) : addToMyList(id))}
                className="flex items-center gap-2 rounded bg-white/20 px-6 py-2.5 font-semibold backdrop-blur hover:bg-white/30"
              >
                {inList ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                My List
              </button>
            </div>

            {item.overview && (
              <p className="max-w-3xl text-base leading-relaxed text-white md:text-lg">
                {item.overview}
              </p>
            )}

            {isSeries && (
              <div id="episodes" className="mt-10">
                <h2 className="mb-4 text-2xl font-semibold">Episodes</h2>
                <EpisodeBrowser
                  title={item.title}
                  poster={poster}
                  tmdbId={item.tmdbId}
                  seriesId={watchIdForItem(item)}
                  onSelect={(season, episode, episodeWatchId) => {
                    router.push(
                      watchHrefForEpisode({
                        watchId: watchIdForItem(item),
                        episodeWatchId: episodeWatchId,
                        tmdbId: item.tmdbId,
                        title: item.title,
                        season,
                        episode,
                      })
                    );
                  }}
                  layout="embedded"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
