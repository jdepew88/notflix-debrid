// Notflix web server. Wraps Next.js so that:
//  - the listening address comes from the installation config (<data>/config/server.json);
//  - by default it listens on 127.0.0.1 only; LAN access is an explicit owner setting;
//  - route handlers get a trustworthy client address (x-notflix-peer, from the TCP socket);
//  - when the owner changes the port or LAN access, it moves to the new address by itself;
//  - it stops cleanly when the launcher asks (run/web.stop) or on Ctrl+C.
//
// Usage: node server.mjs [--dev] [--data-dir <folder>]      (the launcher scripts/notflix.ps1 runs this)
// The launcher always passes --data-dir: it is also how it recognises which installation a running
// server belongs to (the process command line), long after the window that started it has closed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { installPaths, recoveryMessage, resolveDataDir } from "./src/lib/install/paths.mjs";
import { bindAddressFor, ensureEngineLibraryRoot, readServerConfig } from "./src/lib/install/config.mjs";
import { InstallUnavailableError, initializeInstall } from "./src/lib/install/init.mjs";
import { writeJsonAtomic } from "./src/lib/install/store.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
process.env.NODE_ENV ??= dev ? "development" : "production";
process.env.NEXT_TELEMETRY_DISABLED ??= "1";

const dataDirArg = process.argv.indexOf("--data-dir");
if (dataDirArg > 0 && process.argv[dataDirArg + 1]) process.env.NOTFLIX_DATA_DIR = process.argv[dataDirArg + 1];
const { dataDir, source, problem } = resolveDataDir({ appRoot });
if (problem) {
  console.error(`[notflix] ${recoveryMessage(dataDir, problem)}`);
  process.exit(2);
}
// Everything in this process (and the engine the launcher starts) agrees on one data directory.
process.env.NOTFLIX_DATA_DIR = dataDir;
const paths = installPaths(dataDir);

function log(...args) {
  console.log(`[notflix ${new Date().toISOString()}]`, ...args);
}

let init;
try {
  // A remembered folder must already hold an installation; never start over in it silently.
  init = initializeInstall(dataDir, { expectExisting: source === "pointer" });
  ensureEngineLibraryRoot(dataDir, path.join(appRoot, "test-media"));
} catch (err) {
  if (err instanceof InstallUnavailableError) {
    console.error(`[notflix] ${err.message}`);
    process.exit(2);
  }
  console.error(`[notflix] Cannot use the data directory ${dataDir}: ${err instanceof Error ? err.message : err}`);
  console.error("[notflix] Choose another one with NOTFLIX_DATA_DIR or scripts\\notflix.ps1 -DataDir <folder>.");
  process.exit(2);
}
for (const w of init.warnings) log("warning:", w);
log(`Data directory: ${dataDir} (${source})`);

const PEER_HEADER = "x-notflix-peer";
const isLoopback = (a = "") => a === "::1" || a.replace(/^::ffff:/i, "").startsWith("127.");

/** Cached so the per-request check never touches the disk; refreshed when the config changes. */
let allowLan = readServerConfig(dataDir).server.allowLan;

const app = next({ dev, dir: appRoot });
const handle = app.getRequestHandler();
await app.prepare();

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
function onRequest(req, res) {
  // Clients cannot choose their own address: drop any supplied header and set the socket's.
  delete req.headers[PEER_HEADER];
  const peer = req.socket.remoteAddress ?? "";
  req.headers[PEER_HEADER] = peer;
  if (!allowLan && !isLoopback(peer)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("This Notflix server only accepts connections from the computer it runs on.");
    return;
  }
  handle(req, res);
}

/** @param {string} host @param {number} port @returns {Promise<http.Server>} */
function listen(host, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(onRequest);
    server.keepAliveTimeout = 65_000;
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

let current = null; // { server, host, port }

function writeStatus(pending = null) {
  try {
    writeJsonAtomic(paths.listenStatusFile, {
      host: current?.host,
      port: current?.port,
      pid: process.pid,
      since: new Date().toISOString(),
      pending,
    });
  } catch (err) {
    log("could not write listen status:", err instanceof Error ? err.message : err);
  }
}

function describe(host, port) {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${shown}:${port}`;
}

async function applyListenConfig(initial = false) {
  const cfg = readServerConfig(dataDir);
  allowLan = cfg.server.allowLan;
  const host = bindAddressFor(cfg);
  const port = cfg.server.port;
  if (current && current.host === host && current.port === port) return;
  try {
    const server = await listen(host, port);
    const previous = current;
    current = { server, host, port };
    writeStatus(null);
    log(`Listening on ${host}:${port} — open ${describe(host, port)}${cfg.server.allowLan ? " (other devices on your network may connect)" : " (this computer only)"}`);
    if (previous) {
      // Let in-flight responses (including the one that changed the setting) finish first.
      setTimeout(() => previous.server.close(), 5_000).unref();
      previous.server.closeIdleConnections?.();
    }
  } catch (err) {
    const message = /** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE"
      ? `Port ${port} is already in use by another program.`
      : err instanceof Error ? err.message : String(err);
    if (initial) {
      console.error(`[notflix] Could not start on ${host}:${port}: ${message}`);
      console.error("[notflix] Pick another port with: scripts\\notflix.ps1 start -Port <number>");
      process.exit(3);
    }
    log(`Could not move to ${host}:${port}: ${message} Staying on ${current?.host}:${current?.port}.`);
    writeStatus({ host, port, error: message });
  }
}

await applyListenConfig(true);

if (init.setupCode) {
  const url = `${describe(current.host, current.port)}/setup`;
  const line = "=".repeat(64);
  console.log(`\n${line}\n  Welcome to Notflix Debrid — first-run setup\n\n  Open ${url}\n  Setup code: ${init.setupCode}\n\n  (also saved in ${paths.setupCodeFile})\n${line}\n`);
}

// Follow owner changes to the port / LAN access without a restart.
fs.watchFile(paths.serverConfigFile, { interval: 1500 }, () => {
  void applyListenConfig(false);
});

// Graceful stop: Ctrl+C, service stop, or the launcher creating run/web.stop.
const stopFile = path.join(paths.runDir, "web.stop");
fs.rmSync(stopFile, { force: true });
let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${reason})`);
  fs.unwatchFile(paths.serverConfigFile);
  fs.unwatchFile(stopFile);
  fs.rmSync(stopFile, { force: true });
  try {
    fs.rmSync(paths.listenStatusFile, { force: true });
  } catch {
    /* ignore */
  }
  const done = () => process.exit(0);
  if (current) current.server.close(done);
  current?.server.closeAllConnections?.();
  setTimeout(done, 5_000).unref();
}
fs.watchFile(stopFile, { interval: 1000 }, (stat) => {
  if (stat.size >= 0 && fs.existsSync(stopFile)) shutdown("stop requested");
});
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, () => shutdown(signal));
