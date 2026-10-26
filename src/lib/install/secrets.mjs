// Server-side credential store. Secrets live in <data>/secrets (owner-only permissions), are never
// written to config files, logs or browser responses, and are never sent to clients or devices.
//
// On Windows the store is encrypted at rest: the values are sealed with AES-256-GCM under a random
// key, and that key is wrapped with DPAPI (protect.mjs) and kept next to the ciphertext, so a single
// atomic write replaces both. Format:
//   { format: "notflix-secrets/2", protection, wrappedKey, iv, tag, data }      (encrypted)
//   { format: "notflix-secrets/2", protection: "none", values: {...} }           (other systems)
// Files without `format` are the phase-1 plaintext layout; they are read and re-saved encrypted.
import fs from "node:fs";
import crypto from "node:crypto";
import { installPaths } from "./paths.mjs";
import { readJson, withFileLock, writeFileAtomic, writeJsonAtomic } from "./store.mjs";
import { KeyUnavailableError, defaultProtection, protectionLabel, rememberKey, unwrapKey, wrapKey } from "./protect.mjs";

/**
 * @typedef {object} InstallSecrets
 * @property {string} sessionSecret  HMAC key for session/profile cookies
 * @property {string} tmdbApiKey     TMDB v3 API key or v4 read access token
 * @property {string} realDebridToken
 * @property {string} customSourceUrl  optional Stremio-compatible addon URL (may embed a token)
 */

/**
 * @typedef {object} SecretsStatus
 * @property {import("./protect.mjs").Protection | "plaintext-legacy"} protection  how the file on disk is stored
 * @property {"ok" | "empty" | "undecryptable"} state
 * @property {string} label
 * @property {string} [detail]
 */

const FORMAT = "notflix-secrets/2";
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

const AAD = Buffer.from(FORMAT);

/** @param {Buffer} key @param {InstallSecrets} values */
function seal(key, values) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** @param {Buffer} key @param {any} file @returns {InstallSecrets} */
function open(key, file) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(file.iv), "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(String(file.tag), "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(String(file.data), "base64")), decipher.final()]).toString("utf8");
    return normalize(JSON.parse(text));
  } catch {
    throw new KeyUnavailableError("The credential store failed its integrity check (damaged or edited).");
  }
}

/**
 * Reads and decrypts the store. A store that the OS refuses to decrypt (copied from another
 * account or computer, or damaged) yields empty values and state "undecryptable"; environment
 * failures (PowerShell unavailable) throw, so nothing is overwritten on a transient error.
 * @param {string} dataDir
 * @returns {{ values: InstallSecrets, status: SecretsStatus, raw: any }}
 */
export function loadSecrets(dataDir) {
  const raw = readJson(installPaths(dataDir).secretsFile, null);
  const empty = normalize({});
  if (!raw || typeof raw !== "object") {
    const p = defaultProtection();
    return { values: empty, raw, status: { protection: p, state: "empty", label: protectionLabel(p) } };
  }
  if (raw.format !== FORMAT) {
    return {
      values: normalize(raw),
      raw,
      status: { protection: "plaintext-legacy", state: "ok", label: "Not encrypted yet (saved before encryption was added)" },
    };
  }
  const protection = raw.protection;
  if (protection === "none") {
    return { values: normalize(raw.values), raw, status: { protection, state: "ok", label: protectionLabel(protection) } };
  }
  if (protection !== "dpapi-user" && protection !== "dpapi-machine") {
    return { values: empty, raw, status: { protection: "none", state: "undecryptable", label: "Unknown protection", detail: String(protection) } };
  }
  if (process.platform !== "win32") {
    return { values: empty, raw, status: { protection, state: "undecryptable", label: protectionLabel(protection), detail: "Encrypted on Windows; this system cannot decrypt it." } };
  }
  try {
    const key = unwrapKey(protection, String(raw.wrappedKey ?? ""));
    return { values: open(key, raw), raw, status: { protection, state: "ok", label: protectionLabel(protection) } };
  } catch (err) {
    if (!(err instanceof KeyUnavailableError)) throw err;
    return { values: empty, raw, status: { protection, state: "undecryptable", label: protectionLabel(protection), detail: err.message } };
  }
}

/** @param {string} dataDir @returns {InstallSecrets} */
export function readSecrets(dataDir) {
  return loadSecrets(dataDir).values;
}

/** @param {string} dataDir @returns {SecretsStatus} */
export function secretsStatus(dataDir) {
  return loadSecrets(dataDir).status;
}

/**
 * Writes the store, reusing the current wrapped key when it is still valid (no DPAPI call) unless
 * `rotate` asks for a new one.
 * @param {string} file
 * @param {InstallSecrets} values
 * @param {any} previous  the parsed file being replaced
 * @param {boolean} rotate
 */
function persist(file, values, previous, rotate) {
  const protection = defaultProtection();
  if (protection === "none") {
    writeJsonAtomic(file, { format: FORMAT, protection, values }, { mode: 0o600 });
    return;
  }
  let wrappedKey = "";
  /** @type {Buffer | null} */
  let key = null;
  if (!rotate && previous?.format === FORMAT && previous.protection === protection && previous.wrappedKey) {
    try {
      key = unwrapKey(protection, previous.wrappedKey);
      wrappedKey = previous.wrappedKey;
    } catch (err) {
      if (!(err instanceof KeyUnavailableError)) throw err;
    }
  }
  if (!key) {
    key = crypto.randomBytes(32);
    wrappedKey = wrapKey(protection, key);
    rememberKey(protection, wrappedKey, key);
  }
  writeJsonAtomic(file, { format: FORMAT, protection, wrappedKey, ...seal(key, values) }, { mode: 0o600 });
}

/**
 * Keeps a store this account cannot decrypt instead of overwriting it, so moving the folder back
 * (or restoring the right Windows account) can still recover it. Returns the kept path.
 * @param {string} file
 */
function quarantine(file) {
  const kept = `${file}.undecryptable-${Date.now()}`;
  fs.renameSync(file, kept);
  return kept;
}

/**
 * Updates credentials under a lock (concurrent saves from two requests must not lose a key).
 * Pass "" to remove a credential; keys that are absent from `patch` are kept.
 * @param {string} dataDir
 * @param {Partial<InstallSecrets>} patch
 * @param {{ rotateKey?: boolean }} [opts]
 * @returns {InstallSecrets}
 */
export function updateSecrets(dataDir, patch, opts = {}) {
  const p = installPaths(dataDir);
  fs.mkdirSync(p.secretsDir, { recursive: true, mode: 0o700 });
  return withFileLock(`${p.secretsFile}.lock`, () => {
    const current = loadSecrets(dataDir);
    if (current.status.state === "undecryptable") quarantine(p.secretsFile);
    const next = { ...current.values };
    for (const k of SECRET_KEYS) {
      const v = /** @type {any} */ (patch)[k];
      if (typeof v === "string") /** @type {any} */ (next)[k] = v.trim();
    }
    if (!next.sessionSecret) next.sessionSecret = randomSecret();
    persist(p.secretsFile, next, current.status.state === "undecryptable" ? null : current.raw, opts.rotateKey === true);
    return next;
  });
}

/** Re-encrypts the store under a newly generated key (credentials are unchanged). */
export function rotateSecretsKey(/** @type {string} */ dataDir) {
  updateSecrets(dataDir, {}, { rotateKey: true });
  return secretsStatus(dataDir);
}

/**
 * Creates the session and engine secrets if they do not exist yet, encrypts a phase-1 plaintext
 * store, and replaces a store this account cannot decrypt (kept aside as *.undecryptable-*; the
 * owner then re-enters the provider credentials and everybody signs in again). Safe to call from
 * several processes at once (the web server and the CLI).
 * @param {string} dataDir
 * @returns {{ createdSession: boolean, createdEngine: boolean, migrated: boolean, recovered: string | null }}
 */
export function ensureInstallSecrets(dataDir) {
  const p = installPaths(dataDir);
  fs.mkdirSync(p.secretsDir, { recursive: true, mode: 0o700 });
  const before = loadSecrets(dataDir);
  let createdSession = false;
  let migrated = false;
  /** @type {string | null} */
  let recovered = null;
  const wanted = defaultProtection();
  if (before.status.state === "undecryptable") {
    recovered = before.status.detail ?? "undecryptable";
    updateSecrets(dataDir, {});
    createdSession = true;
  } else if (!before.values.sessionSecret) {
    updateSecrets(dataDir, {});
    createdSession = true;
  } else if (before.status.protection !== wanted) {
    updateSecrets(dataDir, {});
    migrated = true;
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
  return { createdSession, createdEngine, migrated, recovered };
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
