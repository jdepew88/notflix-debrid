// Minimal media-engine client for scripts/tests (mirrors src/lib/media-engine/tickets.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The engine's shared secret: MEDIA_ENGINE_SECRET, else the first line of
 * $NOTFLIX_DATA_DIR/secrets/engine-secret (the file the engine itself reads). Never logged.
 */
export function readEngineSecret(env = process.env) {
  if (env.MEDIA_ENGINE_SECRET?.trim()) return env.MEDIA_ENGINE_SECRET.trim();
  if (env.NOTFLIX_DATA_DIR) {
    const file = path.join(env.NOTFLIX_DATA_DIR, "secrets", "engine-secret");
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim() || null;
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function mintTicket(secret, source, owner = "test-owner", ttlSeconds = 60) {
  const payload = {
    v: 1,
    owner,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(16).toString("hex"),
    src: source,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function engine({ url, secret, owner = "test-owner" }) {
  const base = url.replace(/\/$/, "");
  const call = async (method, p, { body, session, headers = {}, raw = false } = {}) => {
    const h = { "X-Engine-Key": secret, ...headers };
    if (session) {
      h["X-Session-Token"] = session.token;
      h["X-Owner"] = owner;
    }
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await fetch(`${base}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
    return { status: res.status, json, headers: res.headers };
  };
  return {
    owner,
    call,
    createSession: (source, opts = {}) =>
      call("POST", "/sessions", { body: { ticket: mintTicket(secret, source, owner), ...opts } }),
  };
}

/** Browser capability profiles used by tests (match what the player reports). */
export const CLIENTS = {
  // Chrome/Edge on Windows with a modern GPU: HEVC + AV1 hardware decode, no AC-3/DTS.
  chromeWindows: {
    directVideo: ["h264", "hevc", "av1", "vp9", "vp8"],
    mseVideo: ["h264", "hevc", "av1", "vp9"],
    directAudio: ["aac", "mp3", "opus", "flac", "vorbis"],
    mseAudio: ["aac", "mp3", "opus", "flac"],
    tenBit: ["hevc", "av1", "vp9"],
    hdrDisplay: false,
    mse: true,
  },
  // Browser without HEVC (e.g. Firefox, older Android): forces video transcodes of HEVC.
  noHevc: {
    directVideo: ["h264", "av1", "vp9"],
    mseVideo: ["h264", "av1", "vp9"],
    directAudio: ["aac", "mp3", "opus"],
    mseAudio: ["aac", "mp3", "opus"],
    tenBit: ["av1", "vp9"],
    mse: true,
  },
  // Minimal H.264/AAC-only device (TV browsers).
  h264Only: {
    directVideo: ["h264"], mseVideo: ["h264"], directAudio: ["aac", "mp3"], mseAudio: ["aac", "mp3"], tenBit: [], mse: true,
  },
};
