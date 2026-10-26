// Public identity of this installation: the friendly name shown to TVs and apps, a stable random
// instance ID and the API version. Served by /api/health and advertised on the LAN (lan-advertise.mjs).
// Nothing here is derived from credentials, accounts, paths or hardware IDs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPaths } from "./paths.mjs";
import { writeFileAtomic } from "./store.mjs";

/** Major version of the HTTP API that apps (Android TV) use. Increase only for breaking changes. */
export const API_VERSION = 1;
export const MAX_SERVER_NAME = 60;

const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A display name safe to show and to use as a DNS-SD instance label: printable characters only,
 * no dots (they separate DNS labels), at most 60 characters and 63 UTF-8 bytes.
 * @param {unknown} v
 * @returns {string} "" when nothing usable is left
 */
export function cleanServerName(v) {
  if (typeof v !== "string") return "";
  let s = v
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = [...s].slice(0, MAX_SERVER_NAME).join("");
  while (Buffer.byteLength(s, "utf8") > 63) s = [...s].slice(0, -1).join("");
  return s.trim();
}

/**
 * The owner's chosen name, else this computer's name.
 * @param {{ server: { name?: string } }} cfg
 * @param {string} [hostname]
 */
export function serverName(cfg, hostname = os.hostname()) {
  return cleanServerName(cfg.server.name) || cleanServerName(hostname) || "Notflix";
}

/** @param {string} dataDir */
function instanceIdFile(dataDir) {
  return path.join(installPaths(dataDir).configDir, "instance-id");
}

/**
 * Random ID generated once per data folder (so it moves with move-data and survives updates).
 * @param {string} dataDir
 * @returns {string}
 */
export function instanceId(dataDir) {
  const file = instanceIdFile(dataDir);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (INSTANCE_ID_RE.test(existing)) return existing;
  } catch {
    /* not created yet */
  }
  const id = crypto.randomUUID();
  try {
    // Exclusive create: if another process (the CLI, a second worker) wins the race, use its ID.
    fs.writeFileSync(file, id + "\n", { flag: "wx", mode: 0o644 });
    return id;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") {
      const winner = fs.readFileSync(file, "utf8").trim();
      if (INSTANCE_ID_RE.test(winner)) return winner;
      // Unusable content (hand-edited): replace it.
      writeFileAtomic(file, id + "\n", { mode: 0o644 });
    }
    // Otherwise a read-only data folder: still answer, the ID just won't be stable.
    return id;
  }
}
