"use client";

import { useEffect, useRef, useState } from "react";
import { MediaImage } from "@/components/ui/MediaImage";
import { cardBackdropUrl, posterUrl } from "@/lib/tmdb";
import { WatchProviderLogos } from "@/components/browse/WatchProviderLogos";
import { usePortal } from "@/providers/PortalProvider";
import { useDetailModal } from "@/providers/DetailModalProvider";
import type { MediaItem } from "@/lib/types";
import { useTitleContextMenu } from "@/providers/TitleContextMenuProvider";
import { cn } from "@/lib/cn";

/**
 * Responsive grid of landscape (16:9) cards for genre pages, search and My List: 2 columns on
 * phones, 3 on tablets, 4–5 on laptops and 6 on wide desktops, with equal 12–16 px gutters.
 */
export const CARD_GRID_CLASS =
  "grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:grid-cols-5 3xl:grid-cols-6";

/** Matches CARD_GRID_CLASS so the browser downloads artwork at the size it is shown. */
const GRID_SIZES = "(max-width: 768px) 48vw, (max-width: 1024px) 32vw, (max-width: 1280px) 24vw, (max-width: 1900px) 19vw, 16vw";
const ROW_SIZES = "(max-width: 640px) 240px, (max-width: 1024px) 280px, 340px";

interface TitleCardWithHoverProps {
  item: MediaItem;
  className?: string;
  priority?: boolean;
  large?: boolean;
  /** "row": fixed widths for horizontal rows. "grid": fills its grid cell. */
  layout?: "row" | "grid";
  /** Show the expanded preview card on hover (off inside dialogs). */
  hoverPreview?: boolean;
}

/**
 * Landscape title card. Artwork priority: the title's TMDB backdrop (w780), else a composition of
 * the blurred poster, the undistorted poster and the title, else a branded placeholder. Selecting
 * a card always opens the title's details; playback starts only from an explicit Play.
 */
export function TitleCardWithHover({ item, className, priority, large, layout = "row", hoverPreview = true }: TitleCardWithHoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { setPortal } = usePortal();
  const { openDetail } = useDetailModal();
  const { openContextMenu } = useTitleContextMenu();
  const [isHovered, setIsHovered] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const backdrop = artFailed ? undefined : cardBackdropUrl(item.backdropPath);
  const poster = posterUrl(item.posterPath, "w342");
  const year = item.releaseDate?.slice(0, 4);
  const sizes = layout === "grid" ? GRID_SIZES : ROW_SIZES;

  useEffect(() => {
    if (!hoverPreview || !isHovered || !ref.current) return;
    hoverTimer.current = setTimeout(() => setPortal(ref.current, item), 450);
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, [isHovered, item, setPortal, hoverPreview]);

  const handleClick = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPortal(null, null);
    openDetail(item);
  };

  const progress = item.progress !== undefined && item.progress > 0 ? Math.min(item.progress, 100) : 0;

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`${item.title}${year ? ` (${year})` : ""}, details`}
      data-testid="title-card"
      data-title={item.title}
      data-art={backdrop ? "backdrop" : poster ? "poster-composite" : "placeholder"}
      onClick={handleClick}
      onContextMenu={(e) => openContextMenu(e, item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      onPointerEnter={() => window.matchMedia("(hover: hover)").matches && window.innerWidth >= 768 && setIsHovered(true)}
      onPointerLeave={() => {
        setIsHovered(false);
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
      }}
      className={cn(
        "group/card relative shrink-0 cursor-pointer overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-white/[0.06] transition-[box-shadow,transform] duration-300 ease-cinematic",
        "hover:ring-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        layout === "grid"
          ? "w-full"
          : large
            ? "w-[260px] sm:w-[300px] lg:w-[360px] 2xl:w-[400px]"
            : "w-[220px] sm:w-[250px] lg:w-[300px] 2xl:w-[340px]",
        className
      )}
    >
      <div className="relative aspect-video w-full overflow-hidden">
        {backdrop ? (
          <MediaImage
            src={backdrop}
            alt=""
            fill
            sizes={sizes}
            priority={priority}
            onError={() => setArtFailed(true)}
            className="object-cover transition-transform duration-500 ease-cinematic motion-safe:group-hover/card:scale-[1.04] motion-safe:group-focus-visible/card:scale-[1.04]"
          />
        ) : poster ? (
          // No landscape art: blurred poster backdrop + the undistorted poster + the title.
          <>
            <MediaImage src={poster} alt="" fill sizes="120px" className="scale-125 object-cover opacity-60 blur-xl" />
            <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/50 to-black/10" />
            <div className="absolute inset-y-[8%] right-[5%] aspect-[2/3] overflow-hidden rounded-[3px] shadow-lg ring-1 ring-white/10">
              <MediaImage src={poster} alt="" fill sizes="(max-width: 768px) 30vw, 140px" className="object-cover" />
            </div>
          </>
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,#3a0a0e,transparent_60%),linear-gradient(135deg,#1f1f23,#121214)]" />
        )}

        {/* Title: always legible on artwork without assuming the image contains lettering. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-3 pb-2.5 pt-10",
            !backdrop && "inset-y-0 flex flex-col justify-end bg-none pr-[42%]"
          )}
        >
          <p className={cn("line-clamp-2 font-semibold leading-tight text-white drop-shadow", !backdrop ? "text-base" : "text-sm")}>{item.title}</p>
          {!backdrop && year && <p className="mt-1 text-xs text-white/70">{year}</p>}
        </div>

        {(item.watchProviders || item.tmdbId) && (
          <div className="pointer-events-none absolute right-2 top-2">
            <WatchProviderLogos item={item} logoClassName="h-4 w-4 rounded-[3px]" />
          </div>
        )}

        {progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25" aria-label={`${Math.round(progress)}% watched`}>
            <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
