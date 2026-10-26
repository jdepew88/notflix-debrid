import { useId } from "react";
import { BRAND_RED, BRAND_RED_DEEP, BRAND_RED_LIGHT, BRAND_BLACK, ICON_GLYPH, ICON_GLYPH_TRANSFORM, ICON_VIEWBOX, WORDMARK_PATHS, WORDMARK_VIEWBOX } from "@/lib/brand";
import { cn } from "@/lib/cn";

interface WordmarkProps {
  /** Rendered height in px; width follows the wordmark's proportions. */
  height?: number;
  className?: string;
  /** Accessible name; pass "" when a parent link already names it. */
  title?: string;
}

/** The NOTFLIX wordmark (vector, scales cleanly from favicon-adjacent sizes to hero size). */
export function NotflixWordmark({ height = 28, className, title = "Notflix" }: WordmarkProps) {
  const id = useId();
  const width = (height * WORDMARK_VIEWBOX.width) / WORDMARK_VIEWBOX.height;
  return (
    <svg
      viewBox={`0 0 ${WORDMARK_VIEWBOX.width} ${WORDMARK_VIEWBOX.height}`}
      width={width}
      height={height}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      data-testid="notflix-wordmark"
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={BRAND_RED_LIGHT} />
          <stop offset="0.55" stopColor={BRAND_RED} />
          <stop offset="1" stopColor={BRAND_RED_DEEP} />
        </linearGradient>
      </defs>
      <g fill={`url(#${id}-fill)`} fillRule="evenodd">
        {WORDMARK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** Compact N mark on a rounded black tile (app icon, favicon, loading screen). */
export function NotflixIcon({ size = 32, className, title = "Notflix" }: { size?: number; className?: string; title?: string }) {
  const id = useId();
  return (
    <svg
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id={`${id}-stem`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={BRAND_RED_LIGHT} />
          <stop offset="0.55" stopColor={BRAND_RED} />
          <stop offset="1" stopColor={BRAND_RED_DEEP} />
        </linearGradient>
      </defs>
      <rect width={ICON_VIEWBOX} height={ICON_VIEWBOX} rx="28" fill={BRAND_BLACK} />
      <path d={ICON_GLYPH} transform={ICON_GLYPH_TRANSFORM} fill={`url(#${id}-stem)`} />
    </svg>
  );
}

/** Full-screen brand loader (route loading states). */
export function BrandLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-6" role="status" aria-live="polite">
      <NotflixWordmark height={40} title="" className="motion-safe:animate-[pulseSoft_1.6s_ease-in-out_infinite]" />
      <div className="h-[3px] w-28 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <div className="h-full w-1/3 rounded-full bg-brand motion-safe:animate-[loaderSlide_1.1s_var(--ease-cinematic)_infinite]" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
