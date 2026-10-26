// Installation configuration (non-secret): where the server listens, storage, setup progress.
// Credentials never live here; see secrets.mjs.
import path from "node:path";
import { installPaths } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";
import { cleanServerName } from "./identity.mjs";

export const DEFAULT_WEB_PORT = 8420;
export const DEFAULT_ENGINE_PORT = 8421;
export const DEFAULT_CACHE_GIB = 10;
export const MIN_CACHE_GIB = 1;
export const MAX_CACHE_GIB = 4096;

/** Steps of first-run setup, in order. */
export const SETUP_STEPS = /** @type {const} */ (["server", "owner", "metadata", "debrid", "hardware"]);

/**
 * @typedef {object} ServerConfig
 * @property {number} version
 * @property {{ port: number, allowLan: boolean, bindAddress: string, hostname: string, reverseProxy: boolean, publicUrl: string, name: string, advertise: boolean }} server
 * @property {{ cacheDirectory: string, cacheMaxGiB: number }} storage
 * @property {{ completed: boolean, completedAt: string | null, ownerCreatedAt: string | null, stepsDone: string[] }} setup
 * @property {{ allowSignup: boolean }} accounts
 * @property {{ tmdbValidatedAt: string | null }} metadata
 * @property {{ provider: "real-debrid", validatedAt: string | null, account: string | null, sources: { torrentio: boolean, peerflix: boolean, custom: boolean } }} debrid
 * @property {{ checkedAt: string | null }} hardware
 */

/** @param {string} dataDir @returns {ServerConfig} */
export function defaultServerConfig(dataDir) {
  return {
    version: 1,
    server: {
      port: DEFAULT_WEB_PORT,
      // Local-only until the owner allows other devices on the network.
      allowLan: false,
      bindAddress: "",
      hostname: "",
      reverseProxy: false,
      publicUrl: "",
      // Friendly name for TVs and apps ("" = this computer's name).
      name: "",
      // Announce the server on the local network (mDNS/DNS-SD) while LAN access is on.
      advertise: true,
    },
    storage: { cacheDirectory: installPaths(dataDir).defaultCacheDir, cacheMaxGiB: DEFAULT_CACHE_GIB },
    setup: { completed: false, completedAt: null, ownerCreatedAt: null, stepsDone: [] },
    accounts: { allowSignup: false },
    metadata: { tmdbValidatedAt: null },
    debrid: { provider: "real-debrid", validatedAt: null, account: null, sources: { torrentio: true, peerflix: false, custom: false } },
    hardware: { checkedAt: null },
  };
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** @param {unknown} v */
export function validHostname(v) {
  return typeof v === "string" && (HOSTNAME_RE.test(v) || IPV4_RE.test(v) || /^\[?[0-9a-f:]+\]?$/i.test(v));
}

/** @param {unknown} v */
export function validPort(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 1024 && /** @type {number} */ (v) <= 65535;
}

/**
 * Fills defaults and drops anything malformed, so a hand-edited file cannot crash startup.
 * @param {any} raw
 * @param {string} dataDir
 * @returns {ServerConfig}
 */
export function normalizeServerConfig(raw, dataDir) {
  const d = defaultServerConfig(dataDir);
  const r = raw && typeof raw === "object" ? raw : {};
  const s = r.server ?? {};
  const st = r.storage ?? {};
  const su = r.setup ?? {};
  const deb = r.debrid ?? {};
  const bool = (/** @type {unknown} */ v, /** @type {boolean} */ f) => (typeof v === "boolean" ? v : f);
  const iso = (/** @type {unknown} */ v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  const gib = Number(st.cacheMaxGiB);
  return {
    version: 1,
    server: {
      port: validPort(s.port) ? s.port : d.server.port,
      allowLan: bool(s.allowLan, d.server.allowLan),
      bindAddress: typeof s.bindAddress === "string" && (s.bindAddress === "" || IPV4_RE.test(s.bindAddress) || s.bindAddress === "::") ? s.bindAddress : "",
      hostname: validHostname(s.hostname) ? s.hostname : "",
      reverseProxy: bool(s.reverseProxy, d.server.reverseProxy),
      publicUrl: validPublicUrl(s.publicUrl) ? String(s.publicUrl).replace(/\/+$/, "") : "",
      name: cleanServerName(s.name),
      advertise: bool(s.advertise, d.server.advertise),
    },
    storage: {
      cacheDirectory: typeof st.cacheDirectory === "string" && path.isAbsolute(st.cacheDirectory) ? path.resolve(st.cacheDirectory) : d.storage.cacheDirectory,
      cacheMaxGiB: Number.isFinite(gib) ? Math.min(MAX_CACHE_GIB, Math.max(MIN_CACHE_GIB, Math.round(gib))) : d.storage.cacheMaxGiB,
    },
    setup: {
      completed: bool(su.completed, false),
      completedAt: iso(su.completedAt),
      ownerCreatedAt: iso(su.ownerCreatedAt),
      stepsDone: Array.isArray(su.stepsDone) ? su.stepsDone.filter((/** @type {unknown} */ x) => typeof x === "string" && SETUP_STEPS.includes(/** @type {any} */ (x))) : [],
    },
    accounts: { allowSignup: bool(r.accounts?.allowSignup, false) },
    metadata: { tmdbValidatedAt: iso(r.metadata?.tmdbValidatedAt) },
    debrid: {
      provider: "real-debrid",
      validatedAt: iso(deb.validatedAt),
      account: typeof deb.account === "string" ? deb.account.slice(0, 100) : null,
      sources: {
        torrentio: bool(deb.sources?.torrentio, true),
        peerflix: bool(deb.sources?.peerflix, false),
        custom: bool(deb.sources?.custom, false),
      },
    },
    hardware: { checkedAt: iso(r.hardware?.checkedAt) },
  };
}

/** @param {unknown} v */
export function validPublicUrl(v) {
  if (typeof v !== "string" || !v.trim()) return false;
  try {
    const u = new URL(v.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Address the web server binds to. Without LAN access it listens on loopback only, so nothing
 * else on the network can reach it; external (internet) exposure is never configured here.
 * @param {ServerConfig} cfg
 */
export function bindAddressFor(cfg) {
  if (!cfg.server.allowLan) return "127.0.0.1";
  return cfg.server.bindAddress || "0.0.0.0";
}

/** @param {string} dataDir @returns {ServerConfig} */
export function readServerConfig(dataDir) {
  return normalizeServerConfig(readJson(installPaths(dataDir).serverConfigFile, null), dataDir);
}

/**
 * Read-modify-write of the server config. The mutator receives a normalized copy.
 * @param {string} dataDir
 * @param {(cfg: ServerConfig) => void} mutate
 * @returns {ServerConfig}
 */
export function updateServerConfig(dataDir, mutate) {
  const cfg = readServerConfig(dataDir);
  mutate(cfg);
  const next = normalizeServerConfig(cfg, dataDir);
  writeJsonAtomic(installPaths(dataDir).serverConfigFile, next, { mode: 0o600 });
  return next;
}

/**
 * Media engine configuration file the .NET engine reads at startup (see
 * services/media-engine EngineConfig). Runtime changes are also pushed to the engine's /config.
 * @typedef {object} EngineFileConfig
 * @property {number} port
 * @property {string} bindAddress
 * @property {string} cacheDirectory
 * @property {number} cacheMaxBytes
 * @property {string} hardwareAcceleration
 * @property {string | null} hardwareDevice
 * @property {number} maxConcurrentVideoTranscodes
 * @property {number} maxTranscodeHeight
 * @property {string | null} ffmpegPath
 * @property {string | null} ffprobePath
 * @property {string[]} libraryRoots
 * @property {string[]} allowedPrivateHosts
 */

export const HARDWARE_ACCELERATION_VALUES = /** @type {const} */ (["auto", "nvenc", "qsv", "amf", "vaapi", "videotoolbox", "off"]);

/** @param {string} dataDir @returns {EngineFileConfig} */
export function readEngineConfig(dataDir) {
  const p = installPaths(dataDir);
  const raw = readJson(p.engineConfigFile, /** @type {any} */ ({}));
  const srv = readServerConfig(dataDir);
  const hw = HARDWARE_ACCELERATION_VALUES.includes(raw.hardwareAcceleration) ? raw.hardwareAcceleration : "auto";
  const strList = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
  return {
    port: validPort(raw.port) ? raw.port : DEFAULT_ENGINE_PORT,
    bindAddress: "127.0.0.1",
    cacheDirectory: srv.storage.cacheDirectory,
    cacheMaxBytes: srv.storage.cacheMaxGiB * 1024 ** 3,
    hardwareAcceleration: hw,
    // Same rule as the engine (an index or a Linux render node); anything else would stop it starting.
    hardwareDevice: typeof raw.hardwareDevice === "string" && /^(\d{1,2}|\/dev\/dri\/(renderD|card)\d{1,4})$/.test(raw.hardwareDevice.trim()) ? raw.hardwareDevice.trim() : null,
    maxConcurrentVideoTranscodes: Number.isInteger(raw.maxConcurrentVideoTranscodes) ? Math.min(16, Math.max(1, raw.maxConcurrentVideoTranscodes)) : 3,
    maxTranscodeHeight: Number.isInteger(raw.maxTranscodeHeight) ? Math.min(4320, Math.max(360, raw.maxTranscodeHeight)) : 2160,
    ffmpegPath: typeof raw.ffmpegPath === "string" && raw.ffmpegPath.trim() ? raw.ffmpegPath.trim() : null,
    ffprobePath: typeof raw.ffprobePath === "string" && raw.ffprobePath.trim() ? raw.ffprobePath.trim() : null,
    libraryRoots: strList(raw.libraryRoots),
    allowedPrivateHosts: strList(raw.allowedPrivateHosts),
  };
}

/**
 * @param {string} dataDir
 * @param {Partial<EngineFileConfig>} patch
 * @returns {EngineFileConfig}
 */
export function updateEngineConfig(dataDir, patch) {
  const next = { ...readEngineConfig(dataDir), ...patch, bindAddress: "127.0.0.1" };
  // Storage always mirrors the server config (the single place the owner edits it).
  const srv = readServerConfig(dataDir);
  next.cacheDirectory = srv.storage.cacheDirectory;
  next.cacheMaxBytes = srv.storage.cacheMaxGiB * 1024 ** 3;
  writeJsonAtomic(installPaths(dataDir).engineConfigFile, next, { mode: 0o600 });
  return next;
}

/**
 * Lets the engine read the generated self-test samples (<app>/test-media). Idempotent.
 * @param {string} dataDir
 * @param {string} sampleDir
 */
export function ensureEngineLibraryRoot(dataDir, sampleDir) {
  const current = readEngineConfig(dataDir);
  const full = path.resolve(sampleDir);
  if (current.libraryRoots.some((r) => path.resolve(r).toLowerCase() === full.toLowerCase())) return current;
  return updateEngineConfig(dataDir, { libraryRoots: [...current.libraryRoots, full] });
}
