// Small durable-file helpers: atomic JSON writes and owner-only permissions.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return fallback;
    // Keep an unreadable file for recovery instead of silently overwriting it later.
    if (err instanceof SyntaxError) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
    }
    return fallback;
  }
}

/**
 * Writes through a temporary file, fsync and rename, so a crash or power loss never leaves a
 * half-written file.
 * @param {string} file
 * @param {unknown} data
 * @param {{ mode?: number }} [opts]
 */
export function writeJsonAtomic(file, data, opts = {}) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n", opts);
}

/**
 * @param {string} file
 * @param {string} text
 * @param {{ mode?: number }} [opts]
 */
export function writeFileAtomic(file, text, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", opts.mode ?? 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch {
      // Windows refuses the rename briefly while another process (antivirus, a reader) has the
      // target open. Retry, then fall back to an in-place write.
      if (attempt < 5) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      fs.writeFileSync(file, text, { encoding: "utf8", mode: opts.mode ?? 0o600 });
      fs.rmSync(tmp, { force: true });
      return;
    }
  }
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Limits a directory to the account running Notflix (plus SYSTEM and Administrators on Windows).
 * Credentials and password hashes live under it, so other local users must not read it.
 * Best effort: failures are reported, not thrown.
 * @param {string} dir
 * @returns {string | null} error message, or null on success
 */
export function restrictToOwner(dir) {
  try {
    if (process.platform === "win32") {
      const user = process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
      if (!user) return "unknown user";
      execFileSync(
        "icacls",
        [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/Q"],
        { stdio: "ignore", windowsHide: true, timeout: 15_000 }
      );
    } else {
      fs.chmodSync(dir, 0o700);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Cross-process mutual exclusion through an exclusively created lock file. Used for one-time
 * operations such as creating the owner account, where two concurrent requests must not both win.
 * Stale locks (older than `staleMs`, e.g. after a crash) are broken.
 * @template T
 * @param {string} lockFile
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 * @returns {T}
 */
export function withFileLock(lockFile, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const started = Date.now();
  let fd = -1;
  while (fd < 0) {
    try {
      fd = fs.openSync(lockFile, "wx");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) fs.rmSync(lockFile, { force: true });
      } catch {
        /* raced with the holder releasing it */
      }
      if (Date.now() - started > timeoutMs) throw new Error("Another request is changing this right now. Try again.");
      sleepSync(15);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}
