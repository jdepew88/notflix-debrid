/**
 * NOTFLIX brand geometry: original letterforms drawn on a 100-unit cap height (condensed, heavy,
 * squared counters). Shared by the React logo components and scripts/generate-brand.mjs, so the
 * header, favicon, app icons and social image all use exactly the same shapes.
 */
export const BRAND_RED = "#e50914";
export const BRAND_RED_LIGHT = "#ff2a35";
export const BRAND_RED_DEEP = "#b8060f";
export const BRAND_BLACK = "#0d0d0f";

/** Letter outlines (x offsets already applied). */
export const WORDMARK_PATHS = [
  // N
  "M0 100V0h20l18 52V0h20v100H38L20 48v52z",
  // O (even-odd counter)
  "M82 0h20a18 18 0 0 1 18 18v64a18 18 0 0 1-18 18H82a18 18 0 0 1-18-18V18A18 18 0 0 1 82 0zm6 20a4 4 0 0 0-4 4v52a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V24a4 4 0 0 0-4-4z",
  // T
  "M126 0h54v20h-17v80h-20V20h-17z",
  // F
  "M186 0h48v20h-28v20h24v19h-24v41h-20z",
  // L
  "M240 0h20v80h26v20h-46z",
  // I
  "M292 0h20v100h-20z",
  // X
  "M318 0h21l9 30 9-30h21l-18 50 18 50h-21l-9-30-9 30h-21l18-50z",
] as const;

export const WORDMARK_VIEWBOX = { width: 378, height: 100 };

/**
 * Compact mark: the wordmark's own N glyph (58×100) centred on a black rounded tile, on a 128-unit
 * square. A single flat letterform, so it reads at 16 px and stays clearly our own mark.
 */
export const ICON_VIEWBOX = 128;
export const ICON_GLYPH = WORDMARK_PATHS[0];
export const ICON_GLYPH_TRANSFORM = "translate(42.9 28) scale(0.72)";
