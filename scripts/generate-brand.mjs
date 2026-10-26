#!/usr/bin/env node
/**
 * Writes the NOTFLIX brand assets from the shared geometry in src/lib/brand.ts:
 *   public/brand/notflix-wordmark.svg, notflix-icon.svg, icon-192.png, icon-512.png, maskable-512.png
 *   src/app/icon.svg (favicon), src/app/apple-icon.png, src/app/opengraph-image.png
 *   node scripts/generate-brand.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  BRAND_BLACK,
  BRAND_RED,
  BRAND_RED_DEEP,
  BRAND_RED_LIGHT,
  ICON_GLYPH,
  ICON_GLYPH_TRANSFORM,
  ICON_VIEWBOX,
  WORDMARK_PATHS,
  WORDMARK_VIEWBOX,
} from "../src/lib/brand.ts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const pub = path.join(root, "public", "brand");
const app = path.join(root, "src", "app");
fs.mkdirSync(pub, { recursive: true });

const wordmarkGroup = (id) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND_RED_LIGHT}"/><stop offset=".55" stop-color="${BRAND_RED}"/><stop offset="1" stop-color="${BRAND_RED_DEEP}"/></linearGradient></defs>` +
  `<g fill="url(#${id})" fill-rule="evenodd">${WORDMARK_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g>`;

const wordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORDMARK_VIEWBOX.width} ${WORDMARK_VIEWBOX.height}"><title>Notflix</title>${wordmarkGroup("w")}</svg>`;

/** `pad` shrinks the mark inside the tile (maskable icons need a safe zone). */
const iconSvg = (pad = 0, rounded = true) => {
  const s = ICON_VIEWBOX;
  const scale = (s - pad * 2) / s;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><title>Notflix</title>` +
    `<defs><linearGradient id="st" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND_RED_LIGHT}"/><stop offset=".55" stop-color="${BRAND_RED}"/><stop offset="1" stop-color="${BRAND_RED_DEEP}"/></linearGradient></defs>` +
    `<rect width="${s}" height="${s}" ${rounded ? 'rx="28"' : ""} fill="${BRAND_BLACK}"/>` +
    `<g transform="translate(${pad} ${pad}) scale(${scale})"><path d="${ICON_GLYPH}" transform="${ICON_GLYPH_TRANSFORM}" fill="url(#st)"/></g></svg>`
  );
};

fs.writeFileSync(path.join(pub, "notflix-wordmark.svg"), wordmarkSvg);
fs.writeFileSync(path.join(pub, "notflix-icon.svg"), iconSvg());
fs.writeFileSync(path.join(app, "icon.svg"), iconSvg());

const png = (svg, size) => sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(path.join(pub, "icon-192.png"), await png(iconSvg(), 192));
fs.writeFileSync(path.join(pub, "icon-512.png"), await png(iconSvg(), 512));
fs.writeFileSync(path.join(pub, "maskable-512.png"), await png(iconSvg(22, false), 512));
fs.writeFileSync(path.join(app, "apple-icon.png"), await png(iconSvg(10, false), 180));

// Social preview: wordmark on a dark stage with a soft red glow.
const W = 1200;
const H = 630;
const markW = 760;
const markH = (markW * WORDMARK_VIEWBOX.height) / WORDMARK_VIEWBOX.width;
const og =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<defs><radialGradient id="glow" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#5a0308"/><stop offset=".55" stop-color="#1a0204"/><stop offset="1" stop-color="#070708"/></radialGradient></defs>` +
  `<rect width="${W}" height="${H}" fill="url(#glow)"/>` +
  `<g transform="translate(${(W - markW) / 2} ${H / 2 - markH / 2 - 30}) scale(${markW / WORDMARK_VIEWBOX.width})">${wordmarkGroup("og")}</g>` +
  `<text x="${W / 2}" y="${H / 2 + markH / 2 + 40}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#d6d6da" letter-spacing="1">Your films and series, played your way.</text>` +
  `</svg>`;
fs.writeFileSync(path.join(app, "opengraph-image.png"), await sharp(Buffer.from(og)).png({ compressionLevel: 9 }).toBuffer());

// The default Next.js favicon is replaced by icon.svg.
fs.rmSync(path.join(app, "favicon.ico"), { force: true });

for (const f of ["notflix-wordmark.svg", "notflix-icon.svg", "icon-192.png", "icon-512.png", "maskable-512.png"]) {
  console.log(`public/brand/${f}  ${(fs.statSync(path.join(pub, f)).size / 1024).toFixed(1)} KB`);
}
for (const f of ["icon.svg", "apple-icon.png", "opengraph-image.png"]) {
  console.log(`src/app/${f}  ${(fs.statSync(path.join(app, f)).size / 1024).toFixed(1)} KB`);
}
