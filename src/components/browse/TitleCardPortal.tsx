"use client";

import { useEffect, useRef, useState } from "react";
import { MediaImage } from "@/components/ui/MediaImage";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Plus, ThumbsUp, ChevronDown, Check } from "lucide-react";
import { createPortal } from "react-dom";
import { usePortal } from "@/providers/PortalProvider";
import { useDetailModal } from "@/providers/DetailModalProvider";
import { useAppStore, isInMyList } from "@/lib/store";
import { posterUrl, cardBackdropUrl } from "@/lib/tmdb";
import { playHrefForItem, playLabelForItem } from "@/lib/playback";
import { formatMatchScore } from "@/lib/watch-progress";
import { WatchProviderLogos } from "@/components/browse/WatchProviderLogos";
import { cn } from "@/lib/cn";

function formatRuntime(minutes?: number): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function TitleCardPortal() {
  const { anchorElement, item, setPortal } = usePortal();
  const { openDetail } = useDetailModal();
  const router = useRouter();
  const addToMyList = useAppStore((s) => s.addToMyList);
  const removeFromMyList = useAppStore((s) => s.removeFromMyList);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!item) return;
    const handleScroll = () => setPortal(null, null);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [item, setPortal]);

  if (!mounted || !anchorElement || !item) return null;

  // Viewport coordinates (the preview is position: fixed): a slightly larger card whose artwork is
  // centred over the card it expands, kept inside the window.
  const rect = anchorElement.getBoundingClientRect();
  const cardWidth = Math.min(Math.max(rect.width * 1.3, 300), 440);
  const left = Math.min(Math.max(8, rect.left - (cardWidth - rect.width) / 2), window.innerWidth - cardWidth - 8);
  const artHeight = (cardWidth * 9) / 16;
  const top = Math.max(8, Math.min(rect.top - (artHeight - rect.height) / 2, window.innerHeight - artHeight - 150));

  const poster = posterUrl(item.posterPath, "w500");
  const backdrop = cardBackdropUrl(item.backdropPath);
  const inList = isInMyList(item.id);
  const matchLabel = formatMatchScore(item.rating);
  const playHref = playHrefForItem(item);
  const playLabel = playLabelForItem(item);

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
        className="pointer-events-auto fixed z-[100] overflow-hidden rounded-panel bg-surface shadow-panel ring-1 ring-line-strong"
        style={{
          width: cardWidth,
          left,
          top,
        }}
        onPointerLeave={() => setPortal(null, null)}
      >
        <div className="relative aspect-video w-full bg-zinc-900">
          {backdrop || poster ? (
            <MediaImage
              src={backdrop || poster!}
              alt={item.title}
              fill
              className="object-cover"
              sizes={`${cardWidth}px`}
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-zinc-800 p-4 text-center text-sm">
              {item.title}
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-surface via-transparent to-transparent" />
          <p className="absolute bottom-2 left-3 right-3 line-clamp-1 text-base font-semibold drop-shadow">{item.title}</p>
        </div>

        <div className="p-3">
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(playHref)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black hover:bg-white/80"
              title={playLabel}
            >
              <Play className="h-4 w-4 fill-current" />
            </button>
            <button
              type="button"
              onClick={() => (inList ? removeFromMyList(item.id) : addToMyList(item.id))}
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/50 hover:border-white"
            >
              {inList ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/50 hover:border-white"
            >
              <ThumbsUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setPortal(null, null);
                openDetail(item);
              }}
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/50 hover:border-white"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          {matchLabel && (
            <p className="mb-1 text-sm font-semibold text-green-400">{matchLabel}</p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-netflix-light-gray">
            {item.releaseDate && (
              <span className="border border-white/40 px-1">{item.releaseDate.slice(0, 4)}</span>
            )}
            {item.runtime && <span>{formatRuntime(item.runtime)}</span>}
            <span className="rounded border border-white/40 px-1 text-[10px]">HD</span>
          </div>
          {item.genres && item.genres.length > 0 && (
            <p className="line-clamp-1 text-xs text-netflix-light-gray">
              {item.genres.join(" · ")}
            </p>
          )}
          {(item.watchProviders || item.tmdbId) && (
            <div className="mt-2">
              <WatchProviderLogos item={item} logoClassName="h-6 w-6" />
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
