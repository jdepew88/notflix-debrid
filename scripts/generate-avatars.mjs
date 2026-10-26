#!/usr/bin/env node
/**
 * Generates Notflix's built-in avatars from the original artwork in scripts/avatar-art.mjs:
 * each illustration is rendered to a 384×384 WebP in public/avatars/v2/, and
 * src/lib/avatar-manifest.json lists them by collection.
 *
 * The first-generation avatars (public/avatars/*.svg) are kept as hidden "legacy" entries so
 * profiles that already use one keep rendering; they are no longer offered in the picker.
 *   node scripts/generate-avatars.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ART, COLLECTIONS } from "./avatar-art.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const legacyDir = path.join(root, "public", "avatars");
const outDir = path.join(legacyDir, "v2");
fs.mkdirSync(outDir, { recursive: true });

const SIZE = 384;
const avatars = [];
let total = 0;
for (const [collection, name, label, draw] of ART) {
  const id = `v2-${collection}-${name}`;
  const svg = draw();
  const webp = await sharp(Buffer.from(svg), { density: (72 * SIZE) / 256 })
    .resize(SIZE, SIZE)
    .webp({ quality: 84, effort: 6, smartSubsample: true })
    .toBuffer();
  fs.writeFileSync(path.join(outDir, `${id}.webp`), webp);
  total += webp.length;
  avatars.push({ id, collection, label, src: `/avatars/v2/${id}.webp` });
}

const legacy = fs
  .readdirSync(legacyDir)
  .filter((f) => f.endsWith(".svg"))
  .sort()
  .map((f) => ({ id: f.replace(/\.svg$/, ""), src: `/avatars/${f}` }));

fs.writeFileSync(
  path.join(root, "src", "lib", "avatar-manifest.json"),
  JSON.stringify({ collections: COLLECTIONS, avatars, legacy }, null, 2) + "\n",
  "utf8"
);
console.log(`${avatars.length} avatars in ${COLLECTIONS.length} collections → public/avatars/v2 (${(total / 1024).toFixed(0)} KB total, avg ${(total / avatars.length / 1024).toFixed(1)} KB); ${legacy.length} legacy kept`);
