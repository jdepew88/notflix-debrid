#!/usr/bin/env node
/**
 * Windows installation and onboarding test, as a new user would experience it:
 *
 *   node scripts/test-windows-install.mjs [--keep] [--reuse-copy]
 *
 * 1. Copies the project (tracked + new files, like a ZIP download: no .git, no node_modules, no
 *    builds) to a folder whose path contains spaces and parentheses.
 * 2. Double-click equivalents: Setup-Notflix.cmd (twice: the second run must not reinstall),
 *    Start-Notflix.cmd, Stop-Notflix.cmd, on throwaway data folders and their own ports
 *    (8541/8542 and 8551/8552). The default ports 8420/8421 are expected to be busy (another
 *    instance), which exercises the port-conflict messages; that instance is never touched.
 * 3. First run, launcher behaviour (browser address, no duplicates, lock), fresh-install API
 *    suite (scripts/test-install-e2e.mjs), restart, interrupted setup resumed in real Chrome,
 *    credential links, invalid credentials, owner-only reconfiguration, hardware changes,
 *    credential-problem banner, credential leak checks, clean shutdown with an active conversion.
 *
 * Provider credentials: real TMDB / Real-Debrid accounts are NOT used. Invalid values are sent to
 * the real services; "valid" ones are SIMULATED by writing placeholders into the encrypted store
 * (labelled as such in the output). The browser is not opened for real: NOTFLIX_BROWSER_LOG
 * records the address the launcher would open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { readSecrets, updateSecrets } from "../src/lib/install/secrets.mjs";
import { updateServerConfig } from "../src/lib/install/config.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const reuseCopy = args.includes("--reuse-copy");
const parent = path.join(os.tmpdir(), "Notflix Fresh Copy (test)");
const copy = path.join(parent, "notflix-debrid");
const dataA = path.join(parent, "data A");
const dataB = path.join(parent, "data B");
const browserLog = path.join(parent, "browser-opened.txt");
const evidence = path.join(repo, "test-results", "windows-install");
const A = { web: 8541, engine: 8542, data: dataA };
const B = { web: 8551, engine: 8552, data: dataB };
const SIM_TMDB = "SIMULATEDTMDBKEY0123456789abcdef";
const SIM_RD = "SIMULATEDREALDEBRIDTOKEN000000000000";

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures.push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  return ok;
}
const section = (t) => console.log(`\n# ${t}`);

/**
 * Runs one of the copy's .cmd files the way Explorer does (cmd.exe, own folder). Output goes to a
 * file, not a pipe: the servers a launcher starts inherit its handles, and a pipe would then stay
 * open (and this call wait) for as long as Notflix runs.
 */
let runNo = 0;
function runCmd(file, cmdArgs = [], env = {}, timeoutMs = 20 * 60_000) {
  const q = (s) => (/[\s()&^]/.test(s) ? `"${s}"` : s);
  const outFile = path.join(parent, `cmd-output-${++runNo}.txt`);
  const line = `"${q(path.join(copy, file))}${cmdArgs.length ? " " + cmdArgs.map(q).join(" ") : ""} > ${q(outFile)} 2>&1"`;
  const t0 = Date.now();
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", line], {
    cwd: os.homedir(), // any folder: the launchers must find their own
    windowsVerbatimArguments: true,
    env: { ...process.env, NOTFLIX_NO_PAUSE: "1", NOTFLIX_DATA_DIR: "", ...env },
    stdio: "ignore",
    timeout: timeoutMs,
  });
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  return { code: r.status, out, ms: Date.now() - t0 };
}

/** Addresses listening on a TCP port (netstat; Get-NetTCPConnection can return partial lists). */
function listeners(port) {
  const out = execFileSync("netstat.exe", ["-ano"], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .map((l) => /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l))
    .filter((m) => m && Number(m[2]) === port)
    .map((m) => m[1].replace(/^\[|\]$/g, ""));
}

const startArgs = (inst, extra = []) => ["-DataDir", inst.data, "-Port", String(inst.web), "-EnginePort", String(inst.engine), ...extra];
const start = (inst, extra = [], env = {}) => runCmd("Start-Notflix.cmd", startArgs(inst, extra), { NOTFLIX_BROWSER_LOG: browserLog, ...env });
const stop = (inst) => runCmd("Stop-Notflix.cmd", ["-DataDir", inst.data]);
const lastBrowserUrl = () => (fs.existsSync(browserLog) ? fs.readFileSync(browserLog, "utf8").trim().split(/\r?\n/).pop() : "");

function ps(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }).trim();
}
/** node/dotnet/ffmpeg processes started from the copy or working on its data. */
function copyProcesses() {
  const out = ps(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.ToLower().Contains('${copy.toLowerCase().replace(/'/g, "''")}') -or $_.CommandLine.ToLower().Contains('${parent.toLowerCase().replace(/'/g, "''")}')) -and $_.Name -match '^(node|dotnet|ffmpeg|ffprobe)\\.exe$' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
  );
  return out ? out.split(/\r?\n/).map((l) => ({ pid: Number(l.split(" ")[0]), name: l.split(" ")[1] })) : [];
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** PID from a launcher record (JSON since the process-tracking fix; a bare number before). */
const readPid = (inst, name) => {
  const raw = fs.readFileSync(path.join(inst.data, "run", `${name}.pid`), "utf8").trim();
  return Number(raw.startsWith("{") ? JSON.parse(raw).pid : raw);
};
/**
 * fetch with one retry: after a restart this process's pooled keep-alive connection to the old
 * server is dead, and only the first request on it fails ("fetch failed").
 */
async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    await new Promise((r) => setTimeout(r, 300));
    return fetch(url, init);
  }
}
async function http(url, init) {
  try {
    const r = await fetchRetry(url, { redirect: "manual", ...init });
    return { status: r.status, text: await r.text(), headers: r.headers };
  } catch (err) {
    return { status: 0, text: String(err), headers: new Headers() };
  }
}

class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async json(method, url, body) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetchRetry(this.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    return { status: res.status, data, text };
  }
}

/** Marks TMDB / Real-Debrid as validated with placeholder values (SIMULATED: no real accounts). */
function simulateCredentials(dataDir, which) {
  if (which.includes("metadata")) updateSecrets(dataDir, { tmdbApiKey: SIM_TMDB });
  if (which.includes("debrid")) updateSecrets(dataDir, { realDebridToken: SIM_RD });
  updateServerConfig(dataDir, (c) => {
    const now = new Date().toISOString();
    if (which.includes("metadata")) c.metadata.tmdbValidatedAt = now;
    if (which.includes("debrid")) {
      c.debrid.validatedAt = now;
      c.debrid.account = "simulated";
    }
    for (const s of which) if (!c.setup.stepsDone.includes(s)) c.setup.stepsDone.push(s);
  });
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---------------------------------------------------------------------------------------------
const acceptanceBefore = await http("http://127.0.0.1:8420/api/health");
let dummy = null;

try {
  section("0. A fresh copy, as if downloaded and extracted (no .git, no packages, no builds)");
  if (!reuseCopy || !fs.existsSync(copy)) {
    if (fs.existsSync(parent)) {
      // Only ever our own throwaway folder; refuse if processes from it are still running.
      if (copyProcesses().length) throw new Error(`processes from ${parent} are still running`);
      fs.rmSync(parent, { recursive: true, force: true });
    }
    const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
    for (const f of files) {
      const from = path.join(repo, f);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.copyFileSync(from, path.join(copy, f));
    }
    check("project copied to a path with spaces and parentheses", fs.existsSync(path.join(copy, "Setup-Notflix.cmd")), `${files.length} files → ${copy}`);
  } else {
    for (const d of [dataA, dataB]) fs.rmSync(d, { recursive: true, force: true });
    console.log(`  (reusing ${copy})`);
  }
  fs.rmSync(browserLog, { force: true });
  check("no .git, node_modules or build output in the copy", !fs.existsSync(path.join(copy, ".git")) && (reuseCopy || (!fs.existsSync(path.join(copy, "node_modules")) && !fs.existsSync(path.join(copy, ".next")))));

  section("1. Setup-Notflix.cmd on the fresh copy (prerequisites already installed on this PC)");
  if (!reuseCopy || !fs.existsSync(path.join(copy, ".next", "BUILD_ID"))) {
    const s1 = runCmd("Setup-Notflix.cmd", [], { NOTFLIX_DATA_DIR: dataA });
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, "setup-first-run.log"), s1.out);
    check("first setup succeeds", s1.code === 0, `exit ${s1.code}, ${(s1.ms / 1000).toFixed(0)} s`);
    check("existing Node.js, .NET SDK and FFmpeg detected (nothing installed)", /\[ok\] Node\.js/.test(s1.out) && /\[ok\] \.NET SDK 10/.test(s1.out) && /\[ok\] FFmpeg/.test(s1.out) && !/Setup will install/.test(s1.out));
    check("packages installed and everything built", /Installing web packages/.test(s1.out) && /Media engine built/.test(s1.out) && /Web app built/.test(s1.out) && /Notflix Debrid is installed/.test(s1.out));
  }
  const s2 = runCmd("Setup-Notflix.cmd", [], { NOTFLIX_DATA_DIR: dataA });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "setup-second-run.log"), s2.out);
  check("second setup succeeds without reinstalling packages", s2.code === 0 && /Web packages are up to date/.test(s2.out) && !/Installing web packages/.test(s2.out) && !/winget install/.test(s2.out), `${(s2.ms / 1000).toFixed(0)} s`);
  const dry = runCmd("Setup-Notflix.cmd", ["-DryRun"], { NOTFLIX_SETUP_SIMULATE_MISSING: "ffmpeg" });
  check("SIMULATED missing FFmpeg: installer plans winget install Gyan.FFmpeg only", dry.code === 0 && /would run: winget install --id Gyan\.FFmpeg/.test(dry.out) && !/OpenJS|DotNet\.SDK/.test(dry.out.split("would run")[1] ?? ""));
  const noWinget = runCmd("Setup-Notflix.cmd", [], { NOTFLIX_SETUP_SIMULATE_MISSING: "dotnet", NOTFLIX_SETUP_SIMULATE_NO_WINGET: "1" });
  check("SIMULATED missing WinGet: clear manual instructions, nonzero exit, window would stay open", noWinget.code !== 0 && /WinGet .* not available/.test(noWinget.out) && /dotnet\.microsoft\.com/.test(noWinget.out) && /Setup did not finish/.test(noWinget.out));

  section("2. Start-Notflix.cmd: port conflicts are explained, nothing is left running");
  const busyDefault = runCmd("Start-Notflix.cmd", ["-DataDir", dataA], { NOTFLIX_BROWSER_LOG: browserLog });
  if ((await http("http://127.0.0.1:8421/health")).status === 200) {
    check("engine port already in use → clear message, nonzero exit", busyDefault.code !== 0 && /Port 8421, which the media engine uses, is taken by/.test(busyDefault.out) && /Notflix did not start/.test(busyDefault.out), busyDefault.out.match(/Port 8421[^\n]*/)?.[0]);
  } else {
    console.log("  (8421 free on this machine; engine-port conflict case not exercised here)");
    stop(A);
  }
  const blocker = net.createServer().listen(8561, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const busyWeb = runCmd("Start-Notflix.cmd", ["-DataDir", dataA, "-Port", "8561", "-EnginePort", String(A.engine)], { NOTFLIX_BROWSER_LOG: browserLog });
  // The program is named when Windows lists the socket (netstat); a sandboxed session may only
  // learn that the port is taken.
  check("web port already in use → clear message, nonzero exit", busyWeb.code !== 0 && /Port 8561, which Notflix uses, is taken by (node|another program)/.test(busyWeb.out) && /Start-Notflix\.cmd -Port/.test(busyWeb.out),busyWeb.out.match(/Port 8561[^\n]*/)?.[0]);
  blocker.close();
  check("after a failed start no Notflix process from this copy is left", copyProcesses().length === 0, JSON.stringify(copyProcesses()));

  section("3. First start: services, health, browser address, no duplicates");
  const st1 = start(A);
  fs.writeFileSync(path.join(evidence, "start-first-run.log"), st1.out);
  check("Start-Notflix.cmd succeeds", st1.code === 0, `exit ${st1.code}, ${(st1.ms / 1000).toFixed(0)} s`);
  check("shows the real local address", st1.out.includes(`Notflix is running at http://localhost:${A.web}`));
  check("opens first-run setup with the setup code", /^http:\/\/localhost:8541\/setup#code=[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(lastBrowserUrl()), lastBrowserUrl().replace(/#code=.*/, "#code=…"));
  check("web and engine healthy", (await http(`http://127.0.0.1:${A.web}/api/health`)).status === 200 && (await http(`http://127.0.0.1:${A.engine}/health`)).status === 200);
  // Behavioural check (socket listings can be hidden from sandboxed sessions): reachable on
  // 127.0.0.1, refused on every other address of this computer.
  const lanIps = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
  const reachable = await Promise.all(lanIps.map(async (ip) => ({ ip, status: (await http(`http://${ip}:${A.engine}/health`, { signal: AbortSignal.timeout(3000) })).status })));
  const engineLogFile = path.join(dataA, "logs", "media-engine.log");
  const engineStartLog = fs.existsSync(engineLogFile) ? fs.readFileSync(engineLogFile, "utf8") : "";
  check(
    "media engine listens on 127.0.0.1 only",
    engineStartLog.includes(`listening on http://127.0.0.1:${A.engine}`) && reachable.every((r) => r.status === 0) && (await http(`http://127.0.0.1:${A.engine}/health`)).status === 200,
    `refused on ${reachable.map((r) => r.ip).join(", ") || "(no other addresses)"}`
  );
  // FFmpeg may briefly run for the engine's hardware tests; count the services themselves.
  const services = () => copyProcesses().filter((p) => p.name !== "ffmpeg.exe" && p.name !== "ffprobe.exe");
  const procs1 = services();
  check("exactly one web server and one engine", procs1.filter((p) => p.name === "node.exe").length === 1 && procs1.filter((p) => p.name === "dotnet.exe").length === 1, JSON.stringify(procs1));
  const webPid = readPid(A, "web");
  const enginePid = readPid(A, "engine");
  const st2 = start(A);
  check("starting again: 'already running', same processes, browser opened again", st2.code === 0 && /already running/.test(st2.out) && readPid(A, "web") === webPid && readPid(A, "engine") === enginePid && services().length === procs1.length && /\/setup/.test(lastBrowserUrl()));
  fs.writeFileSync(path.join(A.data, "run", "launcher.lock"), "12345");
  const locked = start(A);
  check("a second launcher while one is starting is refused", locked.code !== 0 && /already starting in another window/.test(locked.out));
  fs.rmSync(path.join(A.data, "run", "launcher.lock"), { force: true });

  section("4. Onboarding through the API (scripts/test-install-e2e.mjs; real TMDB/RD rejection, SIMULATED acceptance)");
  const e2e = spawnSync(process.execPath, [path.join(copy, "scripts", "test-install-e2e.mjs"), "--base", `http://localhost:${A.web}`, "--data", dataA], { cwd: copy, encoding: "utf8", timeout: 15 * 60_000 });
  fs.writeFileSync(path.join(evidence, "install-e2e.log"), e2e.stdout + e2e.stderr);
  const e2eSummary = (e2e.stdout.match(/(\d+) passed, (\d+) failed/) ?? [])[0];
  check("fresh-install API suite", e2e.status === 0, e2eSummary);

  section("5. Restart after completed setup: never reopens onboarding");
  const sp1 = stop(A);
  check("Stop-Notflix.cmd stops both", sp1.code === 0 && /Notflix stopped/.test(sp1.out) && !alive(webPid) && !alive(enginePid));
  const st3 = start(A);
  check("restart succeeds and opens the normal app, not setup", st3.code === 0 && lastBrowserUrl() === `http://localhost:${A.web}/`, lastBrowserUrl());
  const anonSetup = await http(`http://127.0.0.1:${A.web}/setup`);
  check("/setup redirects away once setup is complete", anonSetup.status >= 300 && anonSetup.status < 400 && !/\/setup$/.test(anonSetup.headers.get("location") ?? ""), `${anonSetup.status} → ${anonSetup.headers.get("location")}${anonSetup.status === 0 ? ` (${anonSetup.text})` : ""}`);
  const e2eRestart = spawnSync(process.execPath, [path.join(copy, "scripts", "test-install-e2e.mjs"), "--base", `http://localhost:${A.web}`, "--data", dataA, "--phase", "restart"], { cwd: copy, encoding: "utf8", timeout: 5 * 60_000 });
  fs.writeFileSync(path.join(evidence, "install-e2e-restart.log"), e2eRestart.stdout + e2eRestart.stderr);
  check("persistence after restart", e2eRestart.status === 0, (e2eRestart.stdout.match(/(\d+) passed, (\d+) failed/) ?? [])[0]);

  section("6. Interrupted setup resumes after a restart (second installation, data B)");
  const stB = start(B);
  const codeUrl = lastBrowserUrl();
  check("B starts in first-run setup", stB.code === 0 && /\/setup#code=/.test(codeUrl));
  const baseB = `http://localhost:${B.web}`;
  const ownerB = new Client(baseB);
  const code = codeUrl.split("#code=")[1];
  check("unlock with the code from the launcher", (await ownerB.json("POST", "/api/setup/unlock", { code })).status === 200);
  check("server step saved", (await ownerB.json("PUT", "/api/config/server", {})).status === 200);
  check("owner created", (await ownerB.json("POST", "/api/setup/owner", { name: "first-owner", displayName: "First Owner", password: "first-owner-pass", confirm: "first-owner-pass" })).status === 200);
  check("(user closes everything) Stop-Notflix.cmd", stop(B).code === 0);
  const stB2 = start(B);
  check("restart opens setup again (not finished), without a code now that the owner exists", stB2.code === 0 && lastBrowserUrl() === `${baseB}/setup`, lastBrowserUrl());
  // Signed out, the status API does not list the steps once an owner exists; read the saved config.
  const statusB = (await new Client(baseB).json("GET", "/api/setup/status")).data;
  const savedB = JSON.parse(fs.readFileSync(path.join(dataB, "config", "server.json"), "utf8"));
  check("progress kept: owner exists, server step done, not complete", statusB.ownerExists === true && savedB.setup.stepsDone.includes("server") && statusB.setupComplete === false && savedB.setup.completed === false, JSON.stringify(savedB.setup.stepsDone));

  section("7. The wizard in real Chrome: resume, official credential links, invalid credentials");
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const bodies = [];
  const watchBodies = (c) =>
    c.on("response", async (r) => {
      const type = r.headers()["content-type"] ?? "";
      if (/json|html|javascript|text/.test(type) && r.url().startsWith("http://localhost")) {
        try {
          bodies.push({ url: r.url(), text: await r.text() });
        } catch {
          /* redirects have no body */
        }
      }
    });
  watchBodies(ctx);
  const page = await ctx.newPage();
  await page.goto(lastBrowserUrl());
  await page.getByRole("heading", { name: "Sign in as the owner" }).waitFor({ timeout: 30_000 });
  check("resumed at the owner sign-in step", true);
  await page.locator("#si-name").fill("first-owner");
  await page.locator("#si-password").fill("first-owner-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: /TMDB/ }).waitFor({ timeout: 30_000 });
  check("after sign-in the wizard continues with TMDB (the first unfinished step)", true);
  await page.screenshot({ path: path.join(evidence, "wizard-tmdb.png"), fullPage: true });

  const linkCheck = async (testId, expectedHref, hostRe) => {
    const link = page.getByTestId(testId).getByRole("link");
    const href = await link.getAttribute("href");
    const target = await link.getAttribute("target");
    const rel = (await link.getAttribute("rel")) ?? "";
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 20_000 }), link.click()]);
    // A noopener tab starts blank; wait until it has navigated to the provider.
    await popup.waitForURL(/^https?:\/\//, { timeout: 30_000 }).catch(() => undefined);
    const landed = popup.url();
    const where = URL.canParse(landed) ? new URL(landed) : null;
    const opener = await popup.evaluate(() => window.opener === null).catch(() => true);
    await popup.close();
    return { ok: href === expectedHref && target === "_blank" && /noopener/.test(rel) && /noreferrer/.test(rel) && Boolean(where && hostRe.test(where.hostname)) && opener, detail: `${await link.innerText()} → ${href} (landed on ${where ? where.host + where.pathname : JSON.stringify(landed)}; rel="${rel}")` };
  };
  const tmdbLink = await linkCheck("tmdb-help", "https://www.themoviedb.org/settings/api", /(^|\.)themoviedb\.org$/);
  check("'Get your TMDB API key' opens themoviedb.org/settings/api in a new tab, safely", tmdbLink.ok, tmdbLink.detail);
  const badKey = "0123456789abcdef0123456789abcdef";
  await page.locator("#tmdb-key").fill(badKey);
  await page.getByRole("button", { name: "Save and continue" }).click();
  const tmdbError = page.locator("text=/TMDB rejected|didn.t accept|not accepted|invalid/i").first();
  await tmdbError.waitFor({ timeout: 30_000 });
  check("invalid TMDB key: readable error from the real TMDB check, key not shown", !(await page.locator("body").innerText()).includes(badKey) && (await page.locator("#tmdb-key").getAttribute("type")) === "password", await tmdbError.innerText());

  simulateCredentials(dataB, ["metadata"]);
  await page.reload();
  await page.getByRole("heading", { name: "Real-Debrid" }).waitFor({ timeout: 30_000 });
  check("SIMULATED valid TMDB key: wizard moves on to Real-Debrid after a reload", true);
  const rdLink = await linkCheck("debrid-help", "https://real-debrid.com/apitoken", /(^|\.)real-debrid\.com$/);
  check("'Get your Real-Debrid API token' opens real-debrid.com/apitoken in a new tab, safely", rdLink.ok, rdLink.detail);
  const badToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOP";
  await page.locator("#rd-token").fill(badToken);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForTimeout(500);
  const rdNotice = page.locator("[role=status], [role=alert], .text-red-200, .text-red-300").filter({ hasText: /token|Real-Debrid|bad|invalid/i }).first();
  await rdNotice.waitFor({ timeout: 30_000 }).catch(() => undefined);
  const rdText = await page.locator("body").innerText();
  check("invalid Real-Debrid token: refused by the real service, token not shown", !rdText.includes(badToken) && (await page.getByRole("heading", { name: "Real-Debrid" }).isVisible()) && !readSecrets(dataB).realDebridToken, (await rdNotice.innerText().catch(() => "")).slice(0, 120));

  simulateCredentials(dataB, ["debrid"]);
  await page.reload();
  await page.getByRole("heading", { name: /Graphics card/ }).waitFor({ timeout: 30_000 });
  await page.getByTestId("hw-result").waitFor({ timeout: 120_000 });
  const headline = await page.getByTestId("hw-result").innerText();
  check("hardware step: plain-language result from real detection", /NVIDIA|AMD|Intel|processor/i.test(headline), headline.split("\n")[0]);
  check("hardware step: Automatic selected, processor offered as fallback", (await page.locator("#hw-choice").inputValue()) === "auto" && (await page.locator("#hw-choice option[value=off]").count()) === 1);
  await page.screenshot({ path: path.join(evidence, "wizard-hardware.png"), fullPage: true });
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("heading", { name: "Ready to finish" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL(/\/profiles/, { timeout: 30_000 });
  check("Finish setup opens Notflix", true);
  const statusDone = (await new Client(baseB).json("GET", "/api/setup/status")).data;
  check("setup complete and persisted", statusDone.setupComplete === true);

  section("8. Owner-only reconfiguration (Settings → Run the setup wizard again)");
  await page.goto(`${baseB}/settings`);
  await page.getByTestId("rerun-wizard").click();
  await page.waitForURL(/\/settings\/wizard/);
  await page.getByRole("heading", { name: "Server" }).waitFor({ timeout: 30_000 });
  check("wizard reopens for the owner without the owner-creation step", (await page.getByRole("button", { name: /Owner account/ }).count()) === 0);
  await page.getByRole("button", { name: /TMDB/ }).click();
  await page.getByRole("heading", { name: /TMDB/ }).waitFor();
  // The step renders its heading before it has loaded the stored-key status; wait for that.
  await page.locator("text=Keep current key").waitFor({ timeout: 15_000 }).catch(() => {});
  const tmdbStep = await page.locator("body").innerText();
  check("current key is not shown, only its last characters", !tmdbStep.includes(SIM_TMDB) && (await page.locator("text=Keep current key").count()) === 1, tmdbStep.includes(SIM_TMDB) ? "KEY VISIBLE" : tmdbStep.replace(/\s+/g, " ").slice(tmdbStep.indexOf("TMDB"), tmdbStep.indexOf("TMDB") + 400));
  await page.locator("#tmdb-key").fill(badKey);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.locator("text=/TMDB rejected|didn.t accept|not accepted|invalid/i").first().waitFor({ timeout: 30_000 });
  check("API key replacement: an invalid new key is refused and the working key kept", readSecrets(dataB).tmdbApiKey === SIM_TMDB);
  await page.locator("#tmdb-key").fill("");
  await page.getByRole("button", { name: "Keep current key" }).click();
  await page.getByRole("heading", { name: "Real-Debrid" }).waitFor();
  await page.getByRole("button", { name: /Hardware/ }).click();
  await page.getByTestId("hw-result").waitFor({ timeout: 60_000 });
  const ownerApi = page.request;
  await page.locator("#hw-choice").selectOption("off");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("heading", { name: "Configuration" }).waitFor({ timeout: 60_000 });
  const hwOff = await (await ownerApi.get(`${baseB}/api/config/hardware`)).json();
  check("hardware change: processor only applied", hwOff.settings.hardwareAcceleration === "off" && hwOff.engine.capabilities?.selection?.effective === "software", JSON.stringify(hwOff.engine.capabilities?.selection));
  await page.getByRole("button", { name: /Hardware/ }).click();
  await page.getByTestId("hw-result").waitFor({ timeout: 60_000 });
  await page.locator("#hw-choice").selectOption("auto");
  await page.getByRole("button", { name: "Test again" }).click();
  // The re-test reloads the saved choice; wait until it is done before choosing again.
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => b.getAttribute("aria-busy") === "true"), null, { timeout: 180_000 });
  await page.locator("#hw-choice").selectOption("auto");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("heading", { name: "Configuration" }).waitFor({ timeout: 60_000 });
  const hwAuto = await (await ownerApi.get(`${baseB}/api/config/hardware?refresh=1`)).json();
  check("detection re-run, back to Automatic, settings kept", hwAuto.settings.hardwareAcceleration === "auto" && hwAuto.settings.maxConcurrentTranscodes >= 1 && hwAuto.engine.capabilities?.selection?.effective !== undefined, `effective ${hwAuto.engine.capabilities?.selection?.effective}`);
  const afterReconf = (await new Client(baseB).json("GET", "/api/setup/status")).data;
  check("reconfiguration did not reset setup", afterReconf.setupComplete === true);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForURL(/\/settings$/);

  section("9. Credential problems: owner-only warning, nothing reset");
  await page.goto(`${baseB}/profiles`);
  await page.locator("[data-testid=profile-tile]").first().click();
  await page.waitForURL(/\/browse/);
  const banner = page.getByTestId("owner-config-alert");
  await banner.waitFor({ timeout: 60_000 });
  const bannerText = await banner.innerText();
  check("owner sees a warning that the stored (SIMULATED, so rejected) credentials no longer work", /TMDB no longer accepts/.test(bannerText) && /Real-Debrid no longer accepts/.test(bannerText), bannerText.replace(/\n/g, " | "));
  await page.screenshot({ path: path.join(evidence, "owner-alert.png") });
  check("…and setup stays complete with the credentials still stored", (await new Client(baseB).json("GET", "/api/setup/status")).data.setupComplete === true && readSecrets(dataB).realDebridToken === SIM_RD);
  check("member account created by the owner", (await ownerApi.post(`${baseB}/api/admin/users`, { data: { action: "create", name: "viewer", password: "viewer-pass-1" } })).ok());
  const memberCtx = await browser.newContext();
  watchBodies(memberCtx);
  const member = await memberCtx.newPage();
  await member.goto(`${baseB}/`);
  await member.getByLabel("Username").fill("viewer");
  await member.getByLabel("Password", { exact: true }).fill("viewer-pass-1");
  await member.getByRole("button", { name: /^sign in$/i }).click();
  await member.waitForURL(/\/profiles/);
  await member.locator("[data-testid=profile-tile]").first().click();
  await member.waitForURL(/\/browse/);
  await member.waitForTimeout(3000);
  check("members do not see the owner warning", (await member.getByTestId("owner-config-alert").count()) === 0);
  check("members get 403 from the alert and config APIs", (await member.request.get(`${baseB}/api/config/alerts`)).status() === 403 && (await member.request.get(`${baseB}/api/config/metadata`)).status() === 403);
  await member.goto(`${baseB}/settings/wizard`);
  await member.locator("text=Only the owner can change the server configuration").waitFor({ timeout: 30_000 });
  check("members cannot use the reconfiguration wizard", (await member.locator("#tmdb-key").count()) === 0);
  await member.goto(`${baseB}/settings`);
  await member.waitForTimeout(2000);
  check("no 'run setup again' button for members", (await member.getByTestId("rerun-wizard").count()) === 0);
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`${baseB}/settings/wizard`);
  check("signed-out visitors are sent to sign in", new URL(anonPage.url()).pathname === "/", anonPage.url());
  await browser.close();

  section("10. Credential values never reach browsers or logs");
  const leaks = bodies.filter((b) => b.text.includes(SIM_TMDB) || b.text.includes(SIM_RD));
  check(`no browser response contains a stored credential (${bodies.length} responses checked)`, leaks.length === 0, leaks.map((l) => l.url).join(", "));
  const logFiles = [...filesUnder(path.join(dataA, "logs")), ...filesUnder(path.join(dataB, "logs")), path.join(evidence, "setup-first-run.log"), path.join(evidence, "start-first-run.log"), path.join(evidence, "install-e2e.log")].filter((f) => fs.existsSync(f));
  const logLeaks = logFiles.filter((f) => {
    const t = fs.readFileSync(f, "utf8");
    return t.includes(SIM_TMDB) || t.includes(SIM_RD) || t.includes("SIMULATED-TMDB-KEY-NOT-REAL") || t.includes("SIMULATEDREALDEBRIDTOKENNOTREAL0000");
  });
  check(`no log contains a credential (${logFiles.length} files)`, logLeaks.length === 0, logLeaks.join(", "));
  const disk = [path.join(dataA, "secrets", "secrets.json"), path.join(dataB, "secrets", "secrets.json")].map((f) => fs.readFileSync(f, "utf8"));
  check("credentials encrypted at rest in both installations", disk.every((t) => !t.includes(SIM_TMDB) && !t.includes(SIM_RD) && !t.includes("SIMULATED")));

  section("11. Stop-Notflix.cmd with an active conversion; unrelated processes untouched");
  dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  const ownerA = new Client(`http://localhost:${A.web}`);
  const stateA = JSON.parse(fs.readFileSync(path.join(dataA, "e2e-state.json"), "utf8"));
  check("owner of installation A signs in", (await ownerA.json("POST", "/api/auth/login", { name: stateA.ownerName, password: stateA.ownerPassword })).status === 200);
  const h264Only = { directVideo: ["h264"], directAudio: ["aac"], mseVideo: ["h264"], mseAudio: ["aac"], tenBit: [] };
  // A long sample, so the conversion is still running when Notflix is stopped.
  const sess = await ownerA.json("POST", "/api/playback/sample", { name: "hevc_ac3_long.mkv", client: h264Only });
  const sessionId = sess.data.session?.id;
  await new Promise((r) => setTimeout(r, 2500));
  const ffBefore = copyProcesses().filter((p) => p.name === "ffmpeg.exe");
  const sessionDir = sessionId ? filesUnder(path.join(dataA, "cache")).some((f) => f.includes(sessionId)) : false;
  check("a video conversion is running (FFmpeg + session files)", Boolean(sessionId) && ffBefore.length >= 1 && sessionDir, `${sess.data.session?.mode} via ${sess.data.session?.decision?.pipeline}, ffmpeg ${ffBefore.map((p) => p.pid).join(",")}`);
  const wA = readPid(A, "web");
  const eA = readPid(A, "engine");
  const sp2 = stop(A);
  fs.writeFileSync(path.join(evidence, "stop.log"), sp2.out);
  check("Stop-Notflix.cmd reports success", sp2.code === 0 && /Notflix stopped/.test(sp2.out));
  check("web server, engine and FFmpeg ended", !alive(wA) && !alive(eA) && ffBefore.every((p) => !alive(p.pid)));
  const engineLog = fs.readFileSync(path.join(dataA, "logs", "media-engine.log"), "utf8");
  check("engine shut down gracefully (stop file, not killed)", /Stop requested by the launcher/.test(engineLog));
  check("conversion files cleaned up", !filesUnder(path.join(dataA, "cache")).some((f) => sessionId && f.includes(sessionId)));
  check("an unrelated node.exe is still running", alive(dummy.pid));
  // A stale PID file pointing at somebody else's process must not get it killed.
  const sp3a = stop(B);
  fs.writeFileSync(path.join(dataB, "run", "web.pid"), String(dummy.pid));
  fs.writeFileSync(path.join(dataB, "run", "engine.pid"), String(dummy.pid));
  const sp3 = stop(B);
  check("stale PID files of another process: nothing killed", sp3a.code === 0 && sp3.code === 0 && alive(dummy.pid) && /was not running/.test(sp3.out));
  check("nothing from the test copy is left running", copyProcesses().length === 0, JSON.stringify(copyProcesses()));
  const acceptanceAfter = await http("http://127.0.0.1:8420/api/health");
  if (acceptanceBefore.status === 200) check("the other instance on 8420 was not disturbed", acceptanceAfter.status === 200);
} catch (err) {
  check("test ran without errors", false, err instanceof Error ? err.stack : String(err));
} finally {
  if (dummy) dummy.kill();
  for (const inst of [A, B]) if (fs.existsSync(path.join(inst.data, "run"))) stop(inst);
  if (!keep && copyProcesses().length === 0) {
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {
      console.log(`  (could not remove ${parent})`);
    }
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(evidence, "summary.json"), JSON.stringify({ passed, failed: failures }, null, 2));
process.exit(failures.length ? 1 : 0);
