#!/usr/bin/env node
// Notflix maintenance CLI (used by scripts/notflix.ps1; works offline, without the server).
//
//   node scripts/notflix-cli.mjs paths [--json]            where data, logs and config live
//   node scripts/notflix-cli.mjs init [--json]             create folders/secrets; print the setup code
//   node scripts/notflix-cli.mjs status --json             listening port, setup state (for the launcher)
//   node scripts/notflix-cli.mjs set-port <port>           change the web port (e.g. after a conflict)
//   node scripts/notflix-cli.mjs set-engine-port <port>    change the media engine's port (127.0.0.1 only)
//   node scripts/notflix-cli.mjs allow-lan on|off          allow / forbid other devices on the network
//   node scripts/notflix-cli.mjs advertise on|off          announce / don't announce on the LAN (mDNS)
//   node scripts/notflix-cli.mjs set-name [<name>]         name shown on TVs (empty: computer name)
//   node scripts/notflix-cli.mjs discover [--json]         list Notflix servers announced on the LAN
//   node scripts/notflix-cli.mjs move-data --to <folder>   move accounts/settings/credentials (Notflix stopped)
//   node scripts/notflix-cli.mjs accounts list
//   node scripts/notflix-cli.mjs accounts reset-password <username>   prints a temporary password
//   node scripts/notflix-cli.mjs accounts set-role <username> admin|user
//   node scripts/notflix-cli.mjs credentials status          how stored credentials are protected (no values)
//   node scripts/notflix-cli.mjs credentials rotate-key      re-encrypt them under a new key
//   node scripts/notflix-cli.mjs credentials clear           forget TMDB/Real-Debrid/addon credentials
//   node scripts/notflix-cli.mjs remember-data-dir <folder>  later starts reopen this data folder
//   node scripts/notflix-cli.mjs canonical-paths <path>...   full long paths (JSON; for the launcher)
//
// The data directory is NOTFLIX_DATA_DIR, else the folder this installation used last (remembered in
// .notflix-data-dir by the launcher and move-data), else the OS default (%ProgramData%\NotflixDebrid
// on Windows). Pass --data-dir <folder> to override for one command. A remembered folder that is
// missing or incomplete is an error (exit code 4), never a silent fresh start.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR_POINTER, existingInstallProblem, installPaths, recoveryMessage, resolveDataDir } from "../src/lib/install/paths.mjs";
import { bindAddressFor, ensureEngineLibraryRoot, readEngineConfig, readServerConfig, updateEngineConfig, updateServerConfig, validPort } from "../src/lib/install/config.mjs";
import { InstallUnavailableError, initializeInstall, readSetupCode } from "../src/lib/install/init.mjs";
import { readSecrets, rotateSecretsKey, secretsStatus, updateSecrets } from "../src/lib/install/secrets.mjs";
import { readJson, restrictToOwner, withFileLock, writeFileAtomic, writeJsonAtomic } from "../src/lib/install/store.mjs";
import { MAX_SERVER_NAME, cleanServerName, instanceId, serverName } from "../src/lib/install/identity.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const json = args.includes("--json") ? (args.splice(args.indexOf("--json"), 1), true) : false;
const dataOverride = flag("--data-dir");
const resolved = dataOverride ? { dataDir: path.resolve(dataOverride), source: "argument" } : resolveDataDir({ appRoot });
const { dataDir, source } = resolved;
const p = installPaths(dataDir);
const [command, ...rest] = args;
const pointerFile = path.join(appRoot, DATA_DIR_POINTER);
// The remembered folder must still hold this installation (see paths.mjs existingInstallProblem).
const dataDirProblem = resolved.problem ?? (source === "pointer" ? existingInstallProblem(dataDir) : null);
if (dataDirProblem && !["paths", "status", "discover", "remember-data-dir", "canonical-paths", undefined].includes(command)) {
  fail(recoveryMessage(dataDir, dataDirProblem), 4);
}

function fail(message, code = 1) {
  console.error(`notflix: ${message}`);
  process.exit(code);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverRunning() {
  const status = readJson(p.listenStatusFile, null);
  return Boolean(status?.pid) && alive(status.pid);
}

/** What server.mjs reports about its LAN advertisement; null unless that server is running. */
function advertisement() {
  const status = readJson(p.advertiseStatusFile, null);
  return status?.pid && alive(status.pid) ? status : null;
}

// --- Accounts (same format as src/lib/users.ts and src/lib/auth.ts) ---------------------------
const usersFile = path.join(p.dbDir, "users.json");
const scryptAsync = (pw, salt, n, opts) => new Promise((res, rej) => crypto.scrypt(pw, salt, n, opts, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(password) {
  const N = 2 ** 17, r = 8, pp = 1;
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, 32, { N, r, p: pp, maxmem: 256 * N * r + 32 * 1024 * 1024 });
  return `scrypt$${N},${r},${pp}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
function findUser(data, name) {
  const user = data.users.find((u) => u.name.toLowerCase() === String(name ?? "").toLowerCase());
  if (!user) fail(`no account named "${name}"`);
  return user;
}

async function accounts([sub, name, value]) {
  const data = readJson(usersFile, { users: [] });
  switch (sub) {
    case "list":
      if (!data.users.length) console.log("(no accounts yet — finish first-run setup in the browser)");
      for (const u of data.users) console.log(`${u.name.padEnd(24)} ${(u.role ?? "user").padEnd(6)} created ${u.createdAt}`);
      return;
    case "reset-password": {
      const temporary = crypto.randomBytes(9).toString("base64url");
      const passwordHash = await hashPassword(temporary);
      withFileLock(`${usersFile}.lock`, () => {
        const fresh = readJson(usersFile, { users: [] });
        fs.copyFileSync(usersFile, `${usersFile}.bak-${Date.now()}`);
        const user = findUser(fresh, name);
        user.passwordHash = passwordHash;
        user.sessionVersion = (user.sessionVersion ?? 0) + 1;
        user.passwordChangedAt = new Date().toISOString();
        writeJsonAtomic(usersFile, fresh);
      });
      console.log(`Temporary password for ${name}: ${temporary}`);
      console.log("Sign in with it and change it in Settings → Account. Other devices were signed out.");
      return;
    }
    case "set-role": {
      if (value !== "admin" && value !== "user") fail("role must be admin or user");
      withFileLock(`${usersFile}.lock`, () => {
        const fresh = readJson(usersFile, { users: [] });
        const user = findUser(fresh, name);
        if (user.role === "owner") fail("the owner's role cannot be changed");
        user.role = value;
        writeJsonAtomic(usersFile, fresh);
      });
      console.log(`${name} is now ${value === "admin" ? "an administrator" : "a member"}.`);
      return;
    }
    default:
      fail("usage: accounts list | reset-password <name> | set-role <name> admin|user");
  }
}

// --- Credentials (values are never printed) ------------------------------------------------------
function credentials([sub]) {
  switch (sub) {
    case "status": {
      const status = secretsStatus(dataDir);
      const values = readSecrets(dataDir);
      const out = {
        ...status,
        tmdb: Boolean(values.tmdbApiKey),
        realDebrid: Boolean(values.realDebridToken),
        customSource: Boolean(values.customSourceUrl),
      };
      if (json) console.log(JSON.stringify(out));
      else {
        console.log(`${status.label} — ${status.state}${status.detail ? ` (${status.detail})` : ""}`);
        console.log(`TMDB: ${out.tmdb ? "stored" : "not set"}; Real-Debrid: ${out.realDebrid ? "stored" : "not set"}; custom source: ${out.customSource ? "stored" : "not set"}`);
      }
      return;
    }
    case "rotate-key": {
      if (secretsStatus(dataDir).state === "undecryptable") fail("the stored credentials cannot be decrypted; use \"credentials clear\" and re-enter them");
      const status = rotateSecretsKey(dataDir);
      console.log(`Credentials re-encrypted under a new key. ${status.label}.`);
      return;
    }
    case "clear": {
      updateSecrets(dataDir, { tmdbApiKey: "", realDebridToken: "", customSourceUrl: "" });
      updateServerConfig(dataDir, (c) => {
        c.metadata.tmdbValidatedAt = null;
        c.debrid.validatedAt = null;
        c.debrid.account = null;
      });
      console.log("TMDB, Real-Debrid and custom source credentials removed. Sign in as the owner and enter them in Settings.");
      return;
    }
    default:
      fail("usage: credentials status | rotate-key | clear");
  }
}

// --- Moving the data directory -----------------------------------------------------------------
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function moveData(target) {
  if (!target) fail("usage: move-data --to <folder>");
  const dest = path.resolve(target);
  if (serverRunning()) fail("stop Notflix first (scripts\\notflix.ps1 stop)");
  if (process.env.NOTFLIX_DATA_DIR) fail("NOTFLIX_DATA_DIR is set; change that variable instead");
  if (dest.toLowerCase() === dataDir.toLowerCase()) fail("that is already the data folder");
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) fail(`${dest} is not empty`);
  const cfg = readServerConfig(dataDir);
  for (const sub of ["config", "secrets", "db", "logs"]) {
    const from = path.join(dataDir, sub);
    if (fs.existsSync(from)) copyDir(from, path.join(dest, sub));
  }
  const code = readSetupCode(dataDir);
  if (code) fs.copyFileSync(p.setupCodeFile, installPaths(dest).setupCodeFile);
  // A cache that lived inside the old data folder moves with it; a custom cache stays where it is.
  if (cfg.storage.cacheDirectory.toLowerCase() === p.defaultCacheDir.toLowerCase()) {
    updateServerConfig(dest, (c) => {
      c.storage.cacheDirectory = installPaths(dest).defaultCacheDir;
    });
  }
  const restrictError = restrictToOwner(dest);
  if (restrictError) console.warn(`warning: could not restrict permissions on ${dest}: ${restrictError}`);
  writeFileAtomic(path.join(appRoot, DATA_DIR_POINTER), dest + "\n", { mode: 0o644 });
  console.log(`Copied Notflix data to ${dest}.`);
  console.log(`The old folder ${dataDir} was left in place as a backup; delete it once Notflix works from the new one.`);
}

/** Full, long form of a path (expands 8.3 short names, resolves junctions) when it exists. */
function canonical(p) {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

// --- Commands ------------------------------------------------------------------------------------
switch (command) {
  case "paths": {
    const cfg = readServerConfig(dataDir);
    const out = { dataDir, source, problem: dataDirProblem, recovery: dataDirProblem ? recoveryMessage(dataDir, dataDirProblem) : null, pointerFile, ...p, cacheDirectory: cfg.storage.cacheDirectory, enginePort: readEngineConfig(dataDir).port, webPort: cfg.server.port };
    if (json) console.log(JSON.stringify(out));
    else for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(20)} ${v}`);
    break;
  }
  case "init": {
    let r;
    try {
      r = initializeInstall(dataDir, { expectExisting: source === "pointer" });
      ensureEngineLibraryRoot(dataDir, path.join(appRoot, "test-media"));
    } catch (err) {
      if (err instanceof InstallUnavailableError) fail(err.message, 4);
      fail(`cannot use the data folder ${dataDir}: ${err instanceof Error ? err.message : err}`, 2);
    }
    const cfg = readServerConfig(dataDir);
    const out = { ...r, source, webPort: cfg.server.port, bindAddress: bindAddressFor(cfg), enginePort: readEngineConfig(dataDir).port, logsDir: p.logsDir, runDir: p.runDir };
    if (json) console.log(JSON.stringify(out));
    else {
      console.log(`Data folder: ${dataDir} (${source})`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      if (r.setupCode) console.log(`Setup code: ${r.setupCode}`);
    }
    break;
  }
  case "status": {
    const cfg = readServerConfig(dataDir);
    console.log(
      JSON.stringify({
        dataDir,
        dataDirSource: source,
        problem: dataDirProblem,
        runDir: p.runDir,
        webPort: cfg.server.port,
        bindAddress: bindAddressFor(cfg),
        allowLan: cfg.server.allowLan,
        enginePort: readEngineConfig(dataDir).port,
        setupComplete: cfg.setup.completed,
        setupCode: cfg.setup.completed ? null : readSetupCode(dataDir),
        listening: readJson(p.listenStatusFile, null),
        advertise: cfg.server.advertise,
        serverName: serverName(cfg),
        // Read-only for a folder that cannot be opened: never create files in it.
        instanceId: dataDirProblem ? null : instanceId(dataDir),
        advertisement: advertisement(),
      })
    );
    break;
  }
  case "set-port": {
    const port = Number(rest[0]);
    if (!validPort(port)) fail("use a port between 1024 and 65535");
    if (port === readEngineConfig(dataDir).port) fail("that port belongs to the media engine");
    updateServerConfig(dataDir, (c) => {
      c.server.port = port;
    });
    console.log(`Web port set to ${port}.`);
    break;
  }
  case "set-engine-port": {
    const port = Number(rest[0]);
    if (!validPort(port)) fail("use a port between 1024 and 65535");
    if (port === readServerConfig(dataDir).server.port) fail("that port belongs to the web server");
    updateEngineConfig(dataDir, { port });
    console.log(`Media engine port set to ${port}.`);
    break;
  }
  case "allow-lan": {
    if (rest[0] !== "on" && rest[0] !== "off") fail("usage: allow-lan on|off");
    updateServerConfig(dataDir, (c) => {
      c.server.allowLan = rest[0] === "on";
    });
    console.log(rest[0] === "on" ? "Other devices on your network may connect." : "Only this computer may connect.");
    break;
  }
  case "advertise": {
    if (rest[0] !== "on" && rest[0] !== "off") fail("usage: advertise on|off");
    updateServerConfig(dataDir, (c) => {
      c.server.advertise = rest[0] === "on";
    });
    console.log(rest[0] === "on" ? "Notflix announces itself on the local network while LAN access is on." : "Notflix no longer announces itself; devices connect by address.");
    break;
  }
  case "set-name": {
    const name = rest.join(" ").trim();
    if (name && (cleanServerName(name) !== name || name.length > MAX_SERVER_NAME)) fail(`use up to ${MAX_SERVER_NAME} characters, without dots`);
    const cfg = updateServerConfig(dataDir, (c) => {
      c.server.name = name;
    });
    console.log(`Server name: ${serverName(cfg)}${name ? "" : " (this computer's name)"}`);
    break;
  }
  case "discover": {
    const { browse } = await import("../src/lib/install/lan-advertise.mjs");
    const found = await browse({ timeoutMs: Number(flag("--timeout") ?? 2000) });
    if (json) console.log(JSON.stringify(found));
    else if (!found.length) console.log("No Notflix server answered on the local network.");
    else for (const s of found) console.log(`${s.name}  port ${s.port}  ${s.addresses.join(", ")}  (${Object.entries(s.txt).map(([k, v]) => `${k}=${v}`).join(" ")})`);
    break;
  }
  case "move-data":
    moveData(flag("--to") ?? rest[0]);
    break;
  case "accounts":
    await accounts(rest);
    break;
  case "credentials":
    credentials(rest);
    break;
  case "remember-data-dir": {
    // The launcher calls this after a successful start, so the next start (without -DataDir)
    // reopens the same installation instead of the OS default.
    if (!rest[0] || !path.isAbsolute(rest[0])) fail("usage: remember-data-dir <full folder path>");
    const target = canonical(rest[0]);
    const problem = existingInstallProblem(target);
    if (problem) fail(`not remembering ${target}: ${problem}`);
    let previous = null;
    try {
      previous = fs.readFileSync(pointerFile, "utf8").trim() || null;
    } catch {
      /* none yet */
    }
    const changed = !previous || previous.toLowerCase() !== target.toLowerCase();
    if (changed) writeFileAtomic(pointerFile, target + "\n", { mode: 0o644 });
    console.log(JSON.stringify({ previous, current: target, changed }));
    break;
  }
  case "canonical-paths":
    console.log(JSON.stringify(rest.map(canonical)));
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(command ? 1 : 0);
}
