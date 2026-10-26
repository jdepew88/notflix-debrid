// Installation paths shared by the custom server (server.mjs), the CLI (scripts/notflix-cli.mjs)
// and the Next.js app. Plain ESM with JSDoc so it runs under Node without a build step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_DIR_NAME = "NotflixDebrid";
/** File in the application folder that remembers a data directory chosen during setup. */
export const DATA_DIR_POINTER = ".notflix-data-dir";

/**
 * OS-appropriate default for persistent data (accounts, settings, credentials, logs).
 * Windows: %ProgramData%\NotflixDebrid · macOS: ~/Library/Application Support/NotflixDebrid ·
 * Linux: /var/lib/notflix-debrid when writable (system service), else ~/.local/share/notflix-debrid.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string | undefined>} [env]
 * @param {(dir: string) => boolean} [writable]
 */
export function defaultDataDir(platform = process.platform, env = process.env, writable = canWriteParent) {
  if (platform === "win32") {
    const programData = env.ProgramData || env.PROGRAMDATA || env.ALLUSERSPROFILE || "C:\\ProgramData";
    return path.win32.join(programData, APP_DIR_NAME);
  }
  const home = env.HOME || os.homedir();
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", APP_DIR_NAME);
  const system = "/var/lib/notflix-debrid";
  if (writable(system)) return system;
  const xdg = env.XDG_DATA_HOME || path.posix.join(home, ".local", "share");
  return path.posix.join(xdg, "notflix-debrid");
}

/** @param {string} dir */
function canWriteParent(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    }
    fs.accessSync(path.dirname(dir), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Data directory for this process: NOTFLIX_DATA_DIR, then the pointer file in the application
 * folder (the data folder this installation used last: written by the launcher and by move-data),
 * then the OS default.
 *
 * A pointer that exists but cannot be used is reported as `problem` instead of falling back to the
 * default: falling back would quietly open an empty installation and the first-run wizard.
 * @param {{ env?: Record<string, string | undefined>, appRoot?: string }} [opts]
 * @returns {{ dataDir: string, source: "env" | "pointer" | "default", problem?: string }}
 */
export function resolveDataDir(opts = {}) {
  const env = opts.env ?? process.env;
  const fromEnv = env.NOTFLIX_DATA_DIR?.trim();
  if (fromEnv) return { dataDir: path.resolve(fromEnv), source: "env" };
  const appRoot = opts.appRoot ?? process.cwd();
  const pointerFile = path.join(appRoot, DATA_DIR_POINTER);
  let pointed;
  try {
    pointed = fs.readFileSync(pointerFile, "utf8").trim();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      return { dataDir: defaultDataDir(), source: "pointer", problem: `${pointerFile} cannot be read (${/** @type {Error} */ (err).message})` };
    }
    return { dataDir: defaultDataDir(), source: "default" };
  }
  if (!pointed || !path.isAbsolute(pointed)) {
    return { dataDir: defaultDataDir(), source: "pointer", problem: `${pointerFile} does not contain a full folder path` };
  }
  return { dataDir: path.resolve(pointed), source: "pointer" };
}

/**
 * Why a data folder that should hold an existing installation cannot be opened, or null. Used for
 * the remembered folder (a pointer): a missing folder there means an unplugged drive, a renamed
 * folder or lost data, never "start over".
 * @param {string} dataDir
 * @returns {string | null}
 */
export function existingInstallProblem(dataDir) {
  const p = installPaths(dataDir);
  if (!fs.existsSync(p.dataDir)) return `the folder ${p.dataDir} does not exist (is the drive connected?)`;
  if (!fs.existsSync(p.serverConfigFile)) return `${p.serverConfigFile} is missing`;
  return null;
}

/**
 * Text shown when the installation's data folder cannot be opened. Nothing has been changed.
 * @param {string} dataDir @param {string} reason
 */
export function recoveryMessage(dataDir, reason) {
  return [
    `Notflix cannot open its data folder ${dataDir}: ${reason}.`,
    "Nothing was changed and no new installation was created.",
    "- If the folder is on a removable or network drive, connect it and start Notflix again.",
    "- If you moved or renamed the folder, start Notflix with its new location: Start-Notflix.cmd -DataDir \"<folder>\"",
    "- To deliberately start over with a new, empty installation: Start-Notflix.cmd -DataDir \"<new folder>\"",
  ].join("\n");
}

/**
 * Layout inside the data directory. The cache lives here by default but can be moved; it only ever
 * holds disposable files (HLS segments, probe scratch), never accounts or credentials.
 * @param {string} dataDir
 */
export function installPaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    configDir: path.join(root, "config"),
    secretsDir: path.join(root, "secrets"),
    dbDir: path.join(root, "db"),
    logsDir: path.join(root, "logs"),
    runDir: path.join(root, "run"),
    defaultCacheDir: path.join(root, "cache"),
    serverConfigFile: path.join(root, "config", "server.json"),
    engineConfigFile: path.join(root, "config", "engine.json"),
    playbackConfigFile: path.join(root, "config", "playback.json"),
    secretsFile: path.join(root, "secrets", "secrets.json"),
    engineSecretFile: path.join(root, "secrets", "engine-secret"),
    setupCodeFile: path.join(root, "setup-code.txt"),
    listenStatusFile: path.join(root, "run", "listen-status.json"),
    usersFile: path.join(root, "db", "users.json"),
    advertiseStatusFile: path.join(root, "run", "advertise-status.json"),
  };
}

/** @param {string} p */
function normalized(p) {
  const full = path.resolve(p);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/** @param {string} child @param {string} parent */
export function isSameOrInside(child, parent) {
  const c = normalized(child);
  const p = normalized(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Whether a directory may be used as the disposable media cache. Cache eviction deletes files, so
 * it must never point at (or contain) anything that holds accounts, settings or credentials, a
 * filesystem root, or the application source.
 * @param {string} cacheDir
 * @param {{ dataDir: string, appRoot?: string }} ctx
 * @returns {string | null} a reason when unsafe, else null
 */
export function cacheDirProblem(cacheDir, ctx) {
  if (!cacheDir || !path.isAbsolute(cacheDir)) return "Use a full path (for example D:\\NotflixCache).";
  const full = path.resolve(cacheDir);
  if (path.parse(full).root === full || normalized(path.parse(full).root) === normalized(full)) {
    return "The cache cannot be a drive or filesystem root.";
  }
  const p = installPaths(ctx.dataDir);
  for (const protectedDir of [p.dataDir, p.configDir, p.secretsDir, p.dbDir, p.logsDir, p.runDir]) {
    // The cache may live inside the data directory (its default), but not be one of these folders,
    // contain them, or live inside the credential/account folders.
    if (normalized(full) === normalized(protectedDir)) return "That folder holds Notflix settings or accounts.";
    if (isSameOrInside(protectedDir, full)) return "That folder contains Notflix settings or accounts.";
  }
  for (const sensitive of [p.configDir, p.secretsDir, p.dbDir]) {
    if (isSameOrInside(full, sensitive)) return "The cache cannot live inside the settings or accounts folder.";
  }
  const appRoot = ctx.appRoot ?? process.cwd();
  if (isSameOrInside(full, appRoot) || isSameOrInside(appRoot, full)) {
    return "Keep the cache outside the Notflix application folder.";
  }
  const home = os.homedir();
  if (home && normalized(full) === normalized(home)) return "The cache cannot be your home folder.";
  return null;
}
