// Server-side credential store. Secrets live in <data>/secrets (owner-only permissions), are never
// written to config files, logs or browser responses, and are never sent to clients or devices.
import fs from "node:fs";
import crypto from "node:crypto";
import { installPaths } from "./paths.mjs";
import { readJson, withFileLock, writeFileAtomic, writeJsonAtomic } from "./store.mjs";

/**
 * @typedef {object} InstallSecrets
 * @property {string} sessionSecret  HMAC key for session/profile cookies
 * @property {string} tmdbApiKey     TMDB v3 API key or v4 read access token
 * @property {string} realDebridToken
 * @property {string} customSourceUrl  optional Stremio-compatible addon URL (may embed a token)
 */

const SECRET_KEYS = /** @type {const} */ (["sessionSecret", "tmdbApiKey", "realDebridToken", "customSourceUrl"]);

/** @returns {string} */
export function randomSecret(bytes = 36) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** @param {any} raw @returns {InstallSecrets} */
function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  /** @type {any} */
  const out = {};
  for (const k of SECRET_KEYS) out[k] = typeof r[k] === "string" ? r[k].trim() : "";
  return out;
}

/** @param {string} dataDir @returns {InstallSecrets} */
export function readSecrets(dataDir) {
  return normalize(readJson(installPaths(dataDir).secretsFile, {}));
}

/**
 * Updates credentials under a lock (concurrent saves from two requests must not lose a key).
 * Pass "" to remove a credential; keys that are absent from `patch` are kept.
 * @param {string} dataDir
 * @param {Partial<InstallSecrets>} patch
 * @returns {InstallSecrets}
 */
export function updateSecrets(dataDir, patch) {
  const p = installPaths(dataDir);
  return withFileLock(`${p.secretsFile}.lock`, () => {
    const next = { ...readSecrets(dataDir) };
    for (const k of SECRET_KEYS) {
      const v = /** @type {any} */ (patch)[k];
      if (typeof v === "string") /** @type {any} */ (next)[k] = v.trim();
    }
    if (!next.sessionSecret) next.sessionSecret = randomSecret();
    writeJsonAtomic(p.secretsFile, next, { mode: 0o600 });
    return next;
  });
}

/**
 * Creates the session and engine secrets if they do not exist yet. Safe to call from several
 * processes at once (the web server and the CLI): creation is exclusive.
 * @param {string} dataDir
 * @returns {{ createdSession: boolean, createdEngine: boolean }}
 */
export function ensureInstallSecrets(dataDir) {
  const p = installPaths(dataDir);
  fs.mkdirSync(p.secretsDir, { recursive: true, mode: 0o700 });
  let createdSession = false;
  if (!readSecrets(dataDir).sessionSecret) {
    updateSecrets(dataDir, {});
    createdSession = true;
  }
  let createdEngine = false;
  if (!readEngineSecret(dataDir)) {
    try {
      const fd = fs.openSync(p.engineSecretFile, "wx", 0o600);
      fs.writeSync(fd, randomSecret(36) + "\n");
      fs.closeSync(fd);
      createdEngine = true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      // Exists but was empty/short: replace it.
      if (!readEngineSecret(dataDir)) {
        writeFileAtomic(p.engineSecretFile, randomSecret(36) + "\n");
        createdEngine = true;
      }
    }
  }
  return { createdSession, createdEngine };
}

/** Shared secret between the web server and the media engine (service key + ticket HMAC). */
export function readEngineSecret(/** @type {string} */ dataDir) {
  try {
    const s = fs.readFileSync(installPaths(dataDir).engineSecretFile, "utf8").trim();
    return s.length >= 32 ? s : "";
  } catch {
    return "";
  }
}

/** Last four characters so the owner can tell which credential is stored, never the value itself. */
export function secretHint(/** @type {string} */ secret) {
  return secret && secret.length > 12 ? `…${secret.slice(-4)}` : secret ? "set" : "";
}
