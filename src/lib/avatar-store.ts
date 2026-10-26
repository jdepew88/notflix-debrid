import "server-only";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import sharp from "sharp";
import { getDataPath } from "./data-path";

/**
 * Uploaded profile photos. Stored under DATA_PATH/avatars/<accountId>/<profileId>-<random>.webp,
 * next to the account data (so they survive restarts and rebuilds), and only served to the account
 * that owns them. Every upload is decoded and re-encoded server-side, which drops metadata (EXIF,
 * GPS, ICC comments) and anything that is not image data.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 24_000_000;
export const MIN_SOURCE_SIDE = 64;
export const AVATAR_SIZE = 256;

const FILE_RE = /^[A-Za-z0-9-]{1,64}-[0-9a-f]{16}\.webp$/;
const ID_RE = /^[A-Za-z0-9-]+$/;

export class AvatarError extends Error {}

export function avatarDir(userId: string): string {
  if (!ID_RE.test(userId)) throw new AvatarError("Invalid account");
  return path.join(getDataPath(), "avatars", userId);
}

/** Recognises the container from its first bytes; the declared MIME type is not trusted. */
export function sniffImageType(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export interface CropRect {
  /** Square crop in the image's displayed (EXIF-oriented) pixel space. */
  x: number;
  y: number;
  size: number;
}

export function parseCrop(value: unknown): CropRect | null {
  if (typeof value !== "string" && (typeof value !== "object" || value === null)) return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const { x, y, size } = raw as Record<string, unknown>;
  if (![x, y, size].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: x as number, y: y as number, size: size as number };
}

/** Validates, orients, crops and encodes an uploaded image. Returns the 256×256 WebP bytes. */
export async function processAvatar(input: Buffer, crop: CropRect | null): Promise<Buffer> {
  if (input.length === 0) throw new AvatarError("The file is empty.");
  if (input.length > MAX_UPLOAD_BYTES) throw new AvatarError("Images must be 8 MB or smaller.");
  const sniffed = sniffImageType(input);
  if (!sniffed) throw new AvatarError("Only JPEG, PNG or WebP images can be used.");

  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new AvatarError("That image could not be read. It may be damaged or too large.");
  }
  if (meta.format !== sniffed) throw new AvatarError("The file's contents do not match an allowed image type.");
  if (!meta.width || !meta.height) throw new AvatarError("That image could not be read.");
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new AvatarError("Images may be at most 24 megapixels.");

  // Decode once with EXIF orientation applied, so crop coordinates match what the browser showed.
  let oriented: { data: Buffer; info: sharp.OutputInfo };
  try {
    oriented = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AvatarError("That image could not be decoded.");
  }
  const { width, height, channels } = oriented.info;
  if (Math.min(width, height) < MIN_SOURCE_SIDE) throw new AvatarError(`Images must be at least ${MIN_SOURCE_SIDE}×${MIN_SOURCE_SIDE} pixels.`);

  const side = Math.min(width, height);
  let rect: CropRect = { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), size: side };
  if (crop) {
    const size = Math.round(Math.min(Math.max(crop.size, 32), side));
    rect = {
      x: Math.round(Math.min(Math.max(crop.x, 0), width - size)),
      y: Math.round(Math.min(Math.max(crop.y, 0), height - size)),
      size,
    };
  }

  return sharp(oriented.data, { raw: { width, height, channels } })
    .extract({ left: rect.x, top: rect.y, width: rect.size, height: rect.size })
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "fill", kernel: "lanczos3" })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

/** Stores a processed avatar for a profile and removes that profile's previous uploads (only those). */
export function saveAvatarFile(userId: string, profileId: string, data: Buffer): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(profileId)) throw new AvatarError("Invalid profile");
  const dir = avatarDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${profileId}-${randomBytes(8).toString("hex")}.webp`;
  fs.writeFileSync(path.join(dir, name), data);
  for (const old of fs.readdirSync(dir)) {
    if (old !== name && old.startsWith(`${profileId}-`)) fs.rmSync(path.join(dir, old), { force: true });
  }
  return name;
}

export function deleteProfileAvatarFiles(userId: string, profileId: string): void {
  let dir: string;
  try {
    dir = avatarDir(userId);
  } catch {
    return;
  }
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${profileId}-`)) fs.rmSync(path.join(dir, file), { force: true });
  }
}

/** Absolute path of an uploaded avatar the account owns, or null. */
export function avatarFilePath(userId: string, file: string): string | null {
  if (!FILE_RE.test(file)) return null;
  const full = path.join(avatarDir(userId), file);
  return fs.existsSync(full) ? full : null;
}
