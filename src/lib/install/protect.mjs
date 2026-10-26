// OS-backed protection for the key that encrypts the credential store.
//
// Windows: the key is wrapped with DPAPI (CryptProtectData through .NET's ProtectedData), scoped to
// the Windows account running Notflix by default. A copy of the data folder (a backup, another
// computer, another account) cannot unwrap it. Other systems: no OS key store is used yet, and the
// store relies on owner-only file permissions (see docs/SECURITY.md).
import { execFileSync } from "node:child_process";

/** @typedef {"dpapi-user" | "dpapi-machine" | "none"} Protection */

export const PROTECTIONS = /** @type {const} */ (["dpapi-user", "dpapi-machine", "none"]);

// Not a secret: binds the blob to this application, so another program that unprotects arbitrary
// DPAPI blobs for the same account needs to know it.
const ENTROPY = "NotflixDebrid.credential-store.v2";

/** Thrown when the OS refuses to unwrap the key: different account/computer, or a damaged blob. */
export class KeyUnavailableError extends Error {}

/** @returns {Protection} */
export function defaultProtection() {
  const forced = (process.env.NOTFLIX_SECRET_PROTECTION ?? "").trim().toLowerCase();
  if (forced) {
    if (!PROTECTIONS.includes(/** @type {any} */ (forced))) {
      throw new Error(`NOTFLIX_SECRET_PROTECTION must be one of ${PROTECTIONS.join(", ")}`);
    }
    if (forced !== "none" && process.platform !== "win32") throw new Error(`${forced} is only available on Windows`);
    return /** @type {Protection} */ (forced);
  }
  return process.platform === "win32" ? "dpapi-user" : "none";
}

/** @param {Protection} p */
export function protectionLabel(p) {
  if (p === "dpapi-user") return "Encrypted with Windows DPAPI (this Windows account)";
  if (p === "dpapi-machine") return "Encrypted with Windows DPAPI (this computer)";
  return "Not encrypted: protected by folder permissions only";
}

/**
 * The secret travels on stdin, never on a command line (other processes can read command lines).
 * Exit code 3 means DPAPI itself refused the blob; anything else is an environment failure.
 * @param {"Protect" | "Unprotect"} op
 * @param {"CurrentUser" | "LocalMachine"} scope
 * @param {Buffer} input
 * @returns {Buffer}
 */
function dpapi(op, scope, input) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `try{$out=[Security.Cryptography.ProtectedData]::${op}($in,$e,[Security.Cryptography.DataProtectionScope]::${scope})}catch [Security.Cryptography.CryptographicException]{[Console]::Error.Write($_.Exception.Message);exit 3}`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join(";");
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { input: input.toString("base64"), windowsHide: true, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return Buffer.from(out.toString("utf8").trim(), "base64");
  } catch (err) {
    const e = /** @type {any} */ (err);
    const detail = e?.stderr ? String(e.stderr).trim() : e instanceof Error ? e.message : String(e);
    if (e?.status === 3) throw new KeyUnavailableError(`Windows could not decrypt the credential key: ${detail}`);
    throw new Error(`Windows DPAPI is not available (${detail || "PowerShell failed"})`);
  }
}

/** @param {Protection} p */
function scopeOf(p) {
  return p === "dpapi-machine" ? "LocalMachine" : "CurrentUser";
}

/**
 * @param {Protection} protection
 * @param {Buffer} key
 * @returns {string} base64 wrapped key
 */
export function wrapKey(protection, key) {
  if (protection === "none") throw new Error("no key wrapping without OS protection");
  return dpapi("Protect", scopeOf(protection), key).toString("base64");
}

// Unwrapping costs a PowerShell start (~0.5 s), so each process remembers the result per blob.
const unwrapped = /** @type {Map<string, Buffer>} */ (
  /** @type {any} */ (globalThis).__notflixUnwrappedKeys ??= new Map()
);

/**
 * @param {Protection} protection
 * @param {string} wrapped base64
 * @returns {Buffer}
 */
export function unwrapKey(protection, wrapped) {
  const id = `${protection}:${wrapped}`;
  const hit = unwrapped.get(id);
  if (hit) return hit;
  const key = dpapi("Unprotect", scopeOf(protection), Buffer.from(wrapped, "base64"));
  if (key.length !== 32) throw new KeyUnavailableError("The credential key has the wrong length.");
  unwrapped.set(id, key);
  return key;
}

/** Records a key this process just wrapped so it is not unwrapped again. */
export function rememberKey(/** @type {Protection} */ protection, /** @type {string} */ wrapped, /** @type {Buffer} */ key) {
  unwrapped.set(`${protection}:${wrapped}`, key);
}
