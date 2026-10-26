// First-start initialization: data folders, owner-only permissions, secrets, default config and
// the one-time setup code. Idempotent; run by the launcher (scripts/notflix-cli.mjs init) and by
// the web server on boot.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { installPaths } from "./paths.mjs";
import { readServerConfig, updateEngineConfig, updateServerConfig } from "./config.mjs";
import { ensureInstallSecrets } from "./secrets.mjs";
import { defaultProtection, protectionLabel } from "./protect.mjs";
import { readJson, restrictToOwner } from "./store.mjs";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export function newSetupCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** @param {string} dataDir */
export function ownerExists(dataDir) {
  const users = readJson(path.join(installPaths(dataDir).dbDir, "users.json"), { users: [] });
  return Array.isArray(users.users) && users.users.some((/** @type {any} */ u) => u?.role === "owner");
}

/** @param {string} dataDir */
export function readSetupCode(dataDir) {
  try {
    const code = fs.readFileSync(installPaths(dataDir).setupCodeFile, "utf8").trim();
    return /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** @param {string} dataDir */
export function removeSetupCode(dataDir) {
  fs.rmSync(installPaths(dataDir).setupCodeFile, { force: true });
}

/**
 * @param {string} dataDir
 * @returns {{ dataDir: string, setupComplete: boolean, ownerExists: boolean, setupCode: string | null, warnings: string[], created: boolean }}
 */
export function initializeInstall(dataDir) {
  const p = installPaths(dataDir);
  const warnings = [];
  const created = !fs.existsSync(p.serverConfigFile);
  for (const dir of [p.dataDir, p.configDir, p.secretsDir, p.dbDir, p.logsDir, p.runDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.accessSync(p.dataDir, fs.constants.W_OK);

  // Lock the data folder down once (accounts and credentials live under it).
  const marker = path.join(p.configDir, ".permissions");
  if (!fs.existsSync(marker)) {
    const err = restrictToOwner(p.dataDir);
    if (err) warnings.push(`Could not restrict permissions on ${p.dataDir}: ${err}`);
    else fs.writeFileSync(marker, new Date().toISOString() + "\n");
  }

  const sec = ensureInstallSecrets(dataDir);
  if (sec.recovered) {
    warnings.push(
      `Stored credentials could not be decrypted (${sec.recovered}). They were kept aside as secrets.json.undecryptable-*; ` +
        "sign in again and re-enter the TMDB and Real-Debrid credentials in Settings."
    );
  }
  if (sec.migrated) warnings.push(`Stored credentials re-saved with: ${protectionLabel(defaultProtection())}.`);
  if (created) updateServerConfig(dataDir, () => {});
  if (!fs.existsSync(p.engineConfigFile)) updateEngineConfig(dataDir, {});

  const cfg = readServerConfig(dataDir);
  const owner = ownerExists(dataDir);
  let setupCode = null;
  if (!cfg.setup.completed && !owner) {
    setupCode = readSetupCode(dataDir);
    if (!setupCode) {
      setupCode = newSetupCode();
      try {
        const fd = fs.openSync(p.setupCodeFile, "wx", 0o600);
        fs.writeSync(fd, setupCode + "\n");
        fs.closeSync(fd);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
        setupCode = readSetupCode(dataDir);
      }
    }
  } else if (owner) {
    // The code only guards creating the first owner; afterwards the owner's session is required.
    removeSetupCode(dataDir);
  }
  return { dataDir: p.dataDir, setupComplete: cfg.setup.completed, ownerExists: owner, setupCode, warnings, created };
}
