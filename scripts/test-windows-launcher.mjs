#!/usr/bin/env node
/**
 * Windows launcher process-management and persistence test:
 *
 *   node scripts/test-windows-launcher.mjs [--reuse-copy] [--keep]
 *
 * Builds two separate installations from this repository ("app A", "app B": tracked + new files,
 * Setup-Notflix.cmd, in a folder whose path has spaces and parentheses) and drives them only
 * through the .cmd launchers, the way a user does:
 *
 *   first launch with -DataDir, onboarding once, stop/start/restart without -DataDir (the folder is
 *   remembered), status, lost PID records (launcher window closed), stale PID records pointing at
 *   unrelated processes, servers started by an older launcher, two data folders from one app
 *   folder at the same time, two installations at the same time, a remembered data folder that is
 *   unavailable, damaged settings, an explicit new data folder; LAN discovery (mDNS, _notflix._tcp)
 *   announced with the actual web port while running, withdrawn on stop, re-announced on restart,
 *   following a port change, never for the engine port nor an unfinished setup.
 *
 * Section 12 turns LAN access on for throwaway installations "Notflix Launcher Test A/B": for a
 * minute they listen on all interfaces (ports 8561/8565/8571) and are announced on the local network.
 *
 * Safety: every launcher call gets ProgramData pointed at a throwaway folder, so the OS default
 * data folder (%ProgramData%\NotflixDebrid) is never opened; ports 8561-8564 and 8571-8572 only.
 * Nothing outside the throwaway folder is started or stopped; the test checks that Notflix
 * processes of other folders (e.g. a server on 8420/8421) are still running afterwards.
 * Provider credentials are SIMULATED (placeholders in the encrypted store, as in
 * scripts/test-windows-install.mjs); no real TMDB / Real-Debrid account is used.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSecrets, updateSecrets } from "../src/lib/install/secrets.mjs";
import { updateServerConfig } from "../src/lib/install/config.mjs";
import { browse } from "../src/lib/install/lan-advertise.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const reuseCopy = args.includes("--reuse-copy");
const keep = args.includes("--keep");
const parent = path.join(os.tmpdir(), "Notflix Launcher Test (proc)");
const appA = path.join(parent, "app A");
const appB = path.join(parent, "app B");
const fakeProgramData = path.join(parent, "programdata");
const defaultData = path.join(fakeProgramData, "NotflixDebrid");
const browserLog = path.join(parent, "browser-opened.txt");
const evidence = path.join(repo, "test-results", "windows-launcher");
const A1 = { app: appA, data: path.join(parent, "data A1"), web: 8561, engine: 8562 };
const A2 = { app: appA, data: path.join(parent, "data A2"), web: 8563, engine: 8564 };
const B = { app: appB, data: path.join(parent, "data B"), web: 8571, engine: 8572 };
const SIM_TMDB = "SIMULATEDTMDBKEY0123456789abcdef";
const SIM_RD = "SIMULATEDREALDEBRIDTOKEN000000000000";

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures.push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`);
  return ok;
}
const section = (t) => console.log(`\n# ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a launcher .cmd of an installation as Explorer would; output goes to a file (not a pipe). */
let runNo = 0;
function runCmd(app, file, cmdArgs = [], env = {}) {
  const q = (s) => (/[\s()&^]/.test(s) ? `"${s}"` : s);
  const outFile = path.join(parent, `cmd-output-${++runNo}.txt`);
  const line = `"${q(path.join(app, file))}${cmdArgs.length ? " " + cmdArgs.map(q).join(" ") : ""} > ${q(outFile)} 2>&1"`;
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", line], {
    cwd: os.homedir(),
    windowsVerbatimArguments: true,
    env: { ...process.env, NOTFLIX_NO_PAUSE: "1", NOTFLIX_DATA_DIR: "", ProgramData: fakeProgramData, LOCALAPPDATA: path.join(parent, "localappdata"), NOTFLIX_BROWSER_LOG: browserLog, ...env },
    stdio: "ignore",
    timeout: 20 * 60_000,
  });
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  fs.mkdirSync(evidence, { recursive: true });
  fs.appendFileSync(path.join(evidence, "launcher-output.log"), `\n===== ${path.basename(app)}\\${file} ${cmdArgs.join(" ")} (exit ${r.status})\n${out}`);
  return { code: r.status, out };
}
const inst = (i, extra = []) => ["-DataDir", i.data, "-Port", String(i.web), "-EnginePort", String(i.engine), ...extra];
const start = (app, a = []) => runCmd(app, "Start-Notflix.cmd", a);
const stop = (app, a = []) => runCmd(app, "Stop-Notflix.cmd", a);
const restart = (app, a = []) => runCmd(app, "Restart-Notflix.cmd", a);
const status = (app, a = []) => runCmd(app, "Status-Notflix.cmd", a);
const lastBrowserUrl = () => (fs.existsSync(browserLog) ? fs.readFileSync(browserLog, "utf8").trim().split(/\r?\n/).pop() : "");
const pointer = (app) => (fs.existsSync(path.join(app, ".notflix-data-dir")) ? fs.readFileSync(path.join(app, ".notflix-data-dir"), "utf8").trim() : null);
const same = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function ps(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, maxBuffer: 16 << 20 }).trim();
}
/** All node/dotnet processes: pid, parent, command line. */
function processes() {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='dotnet.exe' OR Name='ffmpeg.exe'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine } } | ConvertTo-Json -Compress`);
  if (!out) return [];
  const list = JSON.parse(out);
  return Array.isArray(list) ? list : [list];
}
/** Notflix services (web/engine) started from an app folder. */
function services(app) {
  const root = app.toLowerCase();
  return processes()
    .filter((p) => p.cmd && p.name !== "ffmpeg.exe" && p.cmd.toLowerCase().includes(root) && /server\.mjs|Notflix\.MediaEngine\.dll/i.test(p.cmd))
    .map((p) => ({ ...p, kind: /server\.mjs/i.test(p.cmd) ? "web" : "engine" }));
}
const underParent = () => processes().filter((p) => p.cmd && p.cmd.toLowerCase().includes(parent.toLowerCase()));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readRecord = (i, kind) => {
  const file = path.join(i.data, "run", `${kind}.pid`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) };
};

async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    await sleep(300);
    return fetch(url, init);
  }
}
async function http(url, init) {
  try {
    const r = await fetchRetry(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
    return { status: r.status, text: await r.text(), headers: r.headers };
  } catch (err) {
    return { status: 0, text: String(err), headers: new Headers() };
  }
}
const healthy = async (i) => (await http(`http://127.0.0.1:${i.web}/api/health`)).status === 200 && (await http(`http://127.0.0.1:${i.engine}/health`)).status === 200;
const down = async (i) => (await http(`http://127.0.0.1:${i.web}/api/health`)).status === 0 && (await http(`http://127.0.0.1:${i.engine}/health`)).status === 0;

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
      const n = pair.indexOf("=");
      this.jar.set(pair.slice(0, n).trim(), pair.slice(n + 1));
    }
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    return { status: res.status, data };
  }
}
const base = (i) => `http://localhost:${i.web}`;
const setupStatus = async (i) => (await new Client(base(i)).json("GET", "/api/setup/status")).data;
const login = async (i, name, password) => (await new Client(base(i)).json("POST", "/api/auth/login", { name, password })).status === 200;
/** Provider credentials as the CLI reports them (stored or not; values are never printed). */
const credentials = (i) =>
  JSON.parse(execFileSync(process.execPath, [path.join(i.app, "scripts", "notflix-cli.mjs"), "credentials", "status", "--json", "--data-dir", i.data], { encoding: "utf8", env: { ...process.env, ProgramData: fakeProgramData } }));

/** Persistence checks after a (re)start of the onboarded installation A1. */
async function assertOnboarded(label, i = A1) {
  const s = await setupStatus(i);
  const setupPage = await http(`http://127.0.0.1:${i.web}/setup`);
  const c = credentials(i);
  check(`${label}: setup still complete, /setup redirects away`, s.setupComplete === true && setupPage.status >= 300 && setupPage.status < 400 && !/\/setup$/.test(setupPage.headers.get("location") ?? ""), `${setupPage.status} → ${setupPage.headers.get("location")}`);
  check(`${label}: owner and member accounts sign in`, (await login(i, "owner", "owner-pass-123")) && (await login(i, "member", "member-pass-123")));
  check(`${label}: provider settings kept (TMDB + Real-Debrid stored and verified)`, c.tmdb && c.realDebrid && readSecrets(i.data).realDebridToken === SIM_RD);
}

/** A process that is not Notflix but whose command line mentions a server.mjs (in another folder). */
function decoy(name) {
  const dir = path.join(parent, "decoy");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "setInterval(() => {}, 1000);\n");
  const p = spawn(process.execPath, [path.join(dir, name)], { detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  return p;
}

/** Starts web + engine the way launchers before this fix did: no --data-dir, bare PID files. */
async function startLegacy(i, { record = true } = {}) {
  const env = { ...process.env, NOTFLIX_DATA_DIR: i.data, ProgramData: fakeProgramData };
  const fds = [];
  const log = (n) => {
    const fd = fs.openSync(path.join(i.data, "logs", `legacy-${n}.log`), "a");
    fds.push(fd);
    return fd;
  };
  const engine = spawn("dotnet", [path.join(i.app, "services", "media-engine", "src", "Notflix.MediaEngine", "bin", "Release", "net10.0", "Notflix.MediaEngine.dll")], { cwd: i.app, env, detached: true, stdio: ["ignore", log("engine"), log("engine")], windowsHide: true });
  const web = spawn("node", [path.join(i.app, "server.mjs")], { cwd: i.app, env, detached: true, stdio: ["ignore", log("web"), log("web")], windowsHide: true });
  engine.unref();
  web.unref();
  // The children have their own handles; keeping ours would lock the data folder.
  for (const fd of fds) fs.closeSync(fd);
  if (record) {
    fs.writeFileSync(path.join(i.data, "run", "engine.pid"), String(engine.pid));
    fs.writeFileSync(path.join(i.data, "run", "web.pid"), String(web.pid));
  }
  for (let n = 0; n < 90 && !(await healthy(i)); n++) await sleep(1000);
  return { web: web.pid, engine: engine.pid };
}

/** Rename with retries: Windows keeps a folder locked briefly after the processes using it exit. */
async function renameRetry(from, to) {
  for (let n = 0; ; n++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (n >= 20) throw err;
      await sleep(500);
    }
  }
}

function copyProject(to) {
  const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of files) {
    const from = path.join(repo, f);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
    fs.copyFileSync(from, path.join(to, f));
  }
  return files.length;
}

// ---------------------------------------------------------------------------------------------
/** Notflix processes of other folders (for example a server on 8420/8421): must survive this test. */
const foreignBefore = processes().filter((p) => p.cmd && /server\.mjs|Notflix\.MediaEngine\.dll/i.test(p.cmd) && !p.cmd.toLowerCase().includes(parent.toLowerCase()));
const decoys = [];

try {
  section("0. Two separate installations built with Setup-Notflix.cmd (throwaway folders, nothing shared)");
  if (underParent().length) throw new Error(`processes from ${parent} are still running; stop them first`);
  if (!reuseCopy || !fs.existsSync(path.join(appB, ".next", "BUILD_ID"))) {
    fs.rmSync(parent, { recursive: true, force: true });
    const n = copyProject(appA);
    const setup = runCmd(appA, "Setup-Notflix.cmd", [], { NOTFLIX_DATA_DIR: path.join(parent, "setup-data"), ProgramData: process.env.ProgramData });
    check("app A: Setup-Notflix.cmd builds it", setup.code === 0, `${n} files; exit ${setup.code}`);
    // The second installation is a copy of the first build (same as extracting the ZIP twice and running setup).
    const rc = spawnSync("robocopy.exe", [appA, appB, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XF", ".notflix-data-dir"], { stdio: "ignore" }).status;
    check("app B: separate copy of the installation", rc < 8 && fs.existsSync(path.join(appB, ".next", "BUILD_ID")), `robocopy exit ${rc}`);
  } else {
    for (const d of [A1.data, A2.data, B.data, fakeProgramData, path.join(parent, "data new"), path.join(parent, "data A1 (moved)"), path.join(parent, "decoy")]) fs.rmSync(d, { recursive: true, force: true });
    for (const app of [appA, appB]) fs.rmSync(path.join(app, ".notflix-data-dir"), { force: true });
    // Launcher/server sources are refreshed (they run unbuilt); the builds are reused.
    const n = copyProject(appA) && copyProject(appB);
    console.log(`  (reusing the builds in ${appA} and ${appB}; ${n} source files refreshed)`);
  }
  fs.rmSync(browserLog, { force: true });
  fs.rmSync(path.join(evidence, "launcher-output.log"), { force: true });
  fs.mkdirSync(fakeProgramData, { recursive: true });

  section("1. First launch through Start-Notflix.cmd with an explicit -DataDir");
  const st1 = start(appA, inst(A1));
  check("starts", st1.code === 0 && (await healthy(A1)), st1.out.match(/\[x\][^\n]*/)?.[0]);
  check("opens first-run setup", /\/setup#code=[A-Z2-9-]{14}$/.test(lastBrowserUrl()), lastBrowserUrl().replace(/#code=.*/, "#code=…"));
  check("the data folder is remembered in the app folder", same(pointer(appA), A1.data), pointer(appA));
  const svc1 = services(appA);
  check("each process carries its data folder on its command line", svc1.length === 2 && svc1.every((p) => p.cmd.includes(`--data-dir "${A1.data}"`)), svc1.map((p) => p.cmd).join(" | "));
  const rec1 = { web: readRecord(A1, "web"), engine: readRecord(A1, "engine") };
  check("PID records hold PID, creation time and data folder", ["web", "engine"].every((k) => rec1[k]?.pid > 0 && rec1[k].started && same(rec1[k].dataDir, A1.data) && svc1.some((p) => p.pid === rec1[k].pid)), JSON.stringify(rec1));
  check("the window that started them is gone; the servers keep running", svc1.every((p) => !alive(p.parent)) && (await healthy(A1)));
  check("the OS default data folder was not used", !fs.existsSync(defaultData));

  section("2. Onboarding once (API; SIMULATED provider validation)");
  const code = lastBrowserUrl().split("#code=")[1];
  const owner = new Client(base(A1));
  check("unlock with the setup code", (await owner.json("POST", "/api/setup/unlock", { code })).status === 200);
  check("server step", (await owner.json("PUT", "/api/config/server", {})).status === 200);
  check("owner account created", (await owner.json("POST", "/api/setup/owner", { name: "owner", displayName: "Owner", password: "owner-pass-123", confirm: "owner-pass-123" })).status === 200);
  updateSecrets(A1.data, { tmdbApiKey: SIM_TMDB, realDebridToken: SIM_RD });
  updateServerConfig(A1.data, (c) => {
    const now = new Date().toISOString();
    c.metadata.tmdbValidatedAt = now;
    c.debrid.validatedAt = now;
    c.debrid.account = "simulated";
    c.setup.stepsDone = [...new Set([...c.setup.stepsDone, "metadata", "debrid"])];
  });
  const done = await owner.json("POST", "/api/setup/complete", {});
  check("setup completed", done.status === 200, JSON.stringify(done.data.missing ?? done.data.error ?? ""));
  check("member account created", (await owner.json("POST", "/api/admin/users", { action: "create", name: "member", password: "member-pass-123" })).status === 200);

  section("3. Stop, start and restart without -DataDir reopen the same installation");
  const sp1 = stop(appA);
  check("Stop-Notflix.cmd (no arguments) stops both", sp1.code === 0 && /Notflix stopped/.test(sp1.out) && services(appA).length === 0 && (await down(A1)), sp1.out.match(/\[(x|!)\][^\n]*/)?.[0]);
  check("records removed after the stop", !readRecord(A1, "web") && !readRecord(A1, "engine"));
  const st2 = start(appA);
  check("Start-Notflix.cmd (no arguments) reopens the remembered data folder", st2.code === 0 && st2.out.includes(`Data folder: ${A1.data} (remembered`) && (await healthy(A1)), st2.out.match(/Data folder:[^\n]*/)?.[0]);
  check("opens the app, not the setup wizard", lastBrowserUrl() === `${base(A1)}/`, lastBrowserUrl());
  await assertOnboarded("after stop + start");
  for (let n = 1; n <= 3; n++) {
    const before = services(appA).map((p) => p.pid);
    const rs = restart(appA);
    const after = services(appA).map((p) => p.pid);
    check(`Restart-Notflix.cmd #${n}: new processes, same data folder, app (not setup) opened`, rs.code === 0 && after.length === 2 && after.every((p) => !before.includes(p)) && rs.out.includes(`Data folder: ${A1.data}`) && lastBrowserUrl() === `${base(A1)}/` && (await healthy(A1)), rs.out.match(/\[(x|!)\][^\n]*/)?.[0]);
  }
  await assertOnboarded("after three restarts");
  check("the OS default data folder was never created", !fs.existsSync(defaultData));

  section("4. Status-Notflix.cmd reports this installation's processes");
  const now4 = services(appA);
  const st4 = status(appA);
  check("status names the data folder and both PIDs", st4.code === 0 && st4.out.includes(`Data folder:  ${A1.data}`) && now4.every((p) => st4.out.includes(`PID ${p.pid}`)) && /Setup:\s+complete/.test(st4.out), st4.out.split(/\r?\n/).filter((l) => /PID|Data folder/.test(l)).join(" / "));

  section("5. Lost PID records (window closed early, run folder cleaned): still found and stopped");
  for (const k of ["web", "engine"]) fs.rmSync(path.join(A1.data, "run", `${k}.pid`), { force: true });
  const st5 = status(appA);
  check("status finds the running servers and tracks them again", st5.code === 0 && /without a record; tracking it again/.test(st5.out) && now4.every((p) => st5.out.includes(`PID ${p.pid}`)) && readRecord(A1, "web")?.pid === now4.find((p) => p.kind === "web").pid);
  for (const k of ["web", "engine"]) fs.rmSync(path.join(A1.data, "run", `${k}.pid`), { force: true });
  const sp5 = stop(appA);
  check("stop without records stops both (no 'not running' while they run)", sp5.code === 0 && /Notflix stopped/.test(sp5.out) && services(appA).length === 0 && (await down(A1)));

  section("6. Stale PID records naming unrelated processes: nothing unrelated is touched");
  const d1 = decoy("server.mjs");
  const d2 = decoy("helper.mjs");
  decoys.push(d1, d2);
  await sleep(500);
  fs.writeFileSync(path.join(A1.data, "run", "web.pid"), String(d1.pid));
  fs.writeFileSync(path.join(A1.data, "run", "engine.pid"), JSON.stringify({ pid: d2.pid, started: new Date().toISOString(), dataDir: A1.data }));
  const sp6 = stop(appA);
  check("stop: 'not running', decoys alive, stale records removed", sp6.code === 0 && /Notflix was not running/.test(sp6.out) && alive(d1.pid) && alive(d2.pid) && /outdated/.test(sp6.out) && !readRecord(A1, "web") && !readRecord(A1, "engine"));
  fs.writeFileSync(path.join(A1.data, "run", "web.pid"), String(d1.pid));
  fs.writeFileSync(path.join(A1.data, "run", "engine.pid"), String(d2.pid));
  const st6 = start(appA);
  check("start with stale records: starts fresh servers (not 'already running')", st6.code === 0 && !/already running/.test(st6.out) && (await healthy(A1)) && alive(d1.pid) && alive(d2.pid) && ![d1.pid, d2.pid].includes(readRecord(A1, "web").pid));
  const st6b = start(appA);
  check("start again: 'already running', no duplicates", st6b.code === 0 && /already running/.test(st6b.out) && services(appA).length === 2);

  section("7. Two data folders from the same app folder at the same time");
  const st7 = start(appA, inst(A2));
  check("second instance (data A2) starts next to A1", st7.code === 0 && (await healthy(A2)) && (await healthy(A1)) && services(appA).length === 4);
  check("…and says that A1 is still running and how to stop it", st7.out.includes(A1.data) && /Also running from this folder/.test(st7.out) && /Later starts use this data folder/.test(st7.out));
  const s7 = status(appA, ["-DataDir", A1.data]);
  const a1Pids = services(appA).filter((p) => p.cmd.includes(A1.data)).map((p) => p.pid);
  check("status -DataDir A1: A1's PIDs as its own, A2 as 'also running'", s7.code === 0 && a1Pids.every((p) => new RegExp(`(Web server|Media engine).*PID ${p}`).test(s7.out)) && s7.out.includes(`with data folder ${A2.data}`));
  const sp7 = stop(appA, ["-DataDir", A2.data]);
  check("stop -DataDir A2 stops only A2", sp7.code === 0 && (await down(A2)) && (await healthy(A1)) && services(appA).length === 2);
  const st7b = start(appA, ["-DataDir", A1.data]);
  check("start -DataDir A1 while it runs: 'already running', remembered again", st7b.code === 0 && /already running/.test(st7b.out) && same(pointer(appA), A1.data));

  section("8. Two installations at the same time (app A and app B)");
  const st8 = start(appB, inst(B));
  check("B starts while A runs", st8.code === 0 && (await healthy(B)) && (await healthy(A1)));
  const s8 = status(appA);
  check("A's status does not claim B's processes", s8.code === 0 && !services(appB).some((p) => s8.out.includes(`PID ${p.pid}`)) && !/Also running/.test(s8.out));
  const blocked = start(appA, ["-DataDir", path.join(parent, "data A3"), "-Port", String(B.web), "-EnginePort", "8565", "-NoBrowser"]);
  check("A on B's port: refused with a clear message, B untouched", blocked.code !== 0 && new RegExp(`Port ${B.web}, which Notflix uses, is taken by (another Notflix installation in ${appB.replace(/[()\\]/g, "\\$&")}|another program)`).test(blocked.out) && (await healthy(B)), blocked.out.match(/Port \d+, which[^\n]*/)?.[0]);
  fs.rmSync(path.join(parent, "data A3"), { recursive: true, force: true });
  start(appA, ["-DataDir", A1.data, "-NoBrowser"]); // remember A1 again (A3 was remembered by nothing: its start failed)
  const sp8 = stop(appA);
  check("stopping A leaves B running", sp8.code === 0 && (await down(A1)) && (await healthy(B)) && services(appB).length === 2);
  const s8b = status(appB);
  check("B's status: running, its own data folder", s8b.code === 0 && s8b.out.includes(`Data folder:  ${B.data}`) && services(appB).every((p) => s8b.out.includes(`PID ${p.pid}`)));
  const sp8b = stop(appB);
  check("B stops", sp8b.code === 0 && (await down(B)) && services(appB).length === 0);

  section("9. Servers started by an older launcher (no --data-dir, bare PID files)");
  const legacy = await startLegacy(A1);
  check("legacy servers running", (await healthy(A1)) && alive(legacy.web) && alive(legacy.engine));
  const s9 = status(appA);
  check("status recognises them from their records", s9.code === 0 && s9.out.includes(`PID ${legacy.web}`) && s9.out.includes(`PID ${legacy.engine}`));
  const sp9 = stop(appA);
  check("stop stops them", sp9.code === 0 && /Notflix stopped/.test(sp9.out) && !alive(legacy.web) && !alive(legacy.engine) && (await down(A1)));
  const legacyA2 = await startLegacy(A2, { record: false });
  const s9b = status(appA);
  check("an older server without a record is reported, not claimed", s9b.code === 0 && /started by an older launcher/.test(s9b.out) && /Stop-Notflix\.cmd -All/.test(s9b.out) && !/Web server\s+http/.test(s9b.out));
  const sp9b = stop(appA);
  check("plain stop leaves it running (not this data folder)", sp9b.code === 0 && alive(legacyA2.web) && /was not running/.test(sp9b.out));
  const sp9c = stop(appA, ["-All"]);
  check("stop -All stops it", sp9c.code === 0 && !alive(legacyA2.web) && !alive(legacyA2.engine) && (await down(A2)));

  section("10. A remembered data folder that is unavailable: recovery error, no new installation");
  const moved = path.join(parent, "data A1 (moved)");
  await renameRetry(A1.data, moved);
  const st10 = start(appA);
  check("start refuses with a recovery message", st10.code !== 0 && /cannot open its data folder/.test(st10.out) && /no new installation was created/.test(st10.out) && /-DataDir/.test(st10.out), st10.out.match(/Notflix cannot open[^\n]*/)?.[0]);
  check("nothing was created: not the old path, not the default", !fs.existsSync(A1.data) && !fs.existsSync(defaultData) && services(appA).length === 0);
  const s10 = status(appA);
  check("status explains the problem", /cannot be opened/.test(s10.out));
  check("stop still works", stop(appA).code === 0);
  await renameRetry(moved, A1.data);
  const st10b = start(appA);
  check("folder back: starts normally", st10b.code === 0 && (await healthy(A1)) && lastBrowserUrl() === `${base(A1)}/`);
  await assertOnboarded("after reconnecting the folder");
  stop(appA);
  const cfgFile = path.join(A1.data, "config", "server.json");
  const good = fs.readFileSync(cfgFile, "utf8");
  fs.writeFileSync(cfgFile, good.slice(0, 50));
  const st10c = start(appA);
  check("damaged settings: refused, file not replaced by defaults", st10c.code !== 0 && /settings file .* cannot be read/.test(st10c.out) && fs.readFileSync(cfgFile, "utf8") === good.slice(0, 50) && services(appA).length === 0, st10c.out.match(/settings file[^\n]*/)?.[0]);
  fs.writeFileSync(cfgFile, good);

  section("11. An explicitly chosen new data folder starts a new installation; switching back works");
  const fresh = { app: appA, data: path.join(parent, "data new"), web: 8563, engine: 8564 };
  const st11 = start(appA, inst(fresh));
  check("new folder: says so, opens first-run setup, becomes the remembered one", st11.code === 0 && /This data folder is new/.test(st11.out) && /\/setup#code=/.test(lastBrowserUrl()) && same(pointer(appA), fresh.data) && st11.out.includes(A1.data));
  const back = restart(appA, ["-DataDir", A1.data]);
  check("restart -DataDir A1: back to the onboarded installation", back.code === 0 && lastBrowserUrl() === `${base(A1)}/` && same(pointer(appA), A1.data));
  // restart stopped A1 (not running) and started it; "data new" still runs (other data folder).
  check("the other data folder's servers were not touched by that restart", services(appA).filter((p) => p.cmd.includes(fresh.data)).length === 2);
  await assertOnboarded("after switching back");
  const sp11 = stop(appA, ["-All"]);
  check("stop -All: everything from app A stopped", sp11.code === 0 && services(appA).length === 0);

  section("12. LAN discovery (mDNS) starts, follows and stops with the right installation");
  const cli = (i, ...a) => execFileSync(process.execPath, [path.join(i.app, "scripts", "notflix-cli.mjs"), ...a, "--data-dir", i.data], { encoding: "utf8", env: { ...process.env, ProgramData: fakeProgramData } });
  const advStatus = (i) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(i.data, "run", "advertise-status.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const waitAdv = async (i, ok) => {
    for (let n = 0; n < 40 && !ok(advStatus(i)); n++) await sleep(250);
    return advStatus(i);
  };
  const idOf = (i) => fs.readFileSync(path.join(i.data, "config", "instance-id"), "utf8").trim();
  const webOf = (i) => services(i.app).find((p) => p.kind === "web" && p.cmd.includes(i.data));
  const brief = (s) => JSON.stringify(s && { active: s.active, port: s.port, pid: s.pid, reason: s.reason, error: s.error });
  // A1 is onboarded; B never finished setup. Both get LAN access (the announcement needs it).
  for (const [i, name] of [[A1, "Notflix Launcher Test A"], [B, "Notflix Launcher Test B"]]) {
    cli(i, "allow-lan", "on");
    cli(i, "set-name", name);
  }
  const st12 = start(appA);
  const a12 = await waitAdv(A1, (s) => s?.active);
  const idA = idOf(A1);
  check("start: the web server announces itself on its actual web port", st12.code === 0 && a12?.active === true && a12.port === A1.web && a12.pid === webOf(A1)?.pid, brief(a12));
  const health = JSON.parse((await http(`http://127.0.0.1:${A1.web}/api/health`)).text || "{}");
  check("/api/health identity (TV verification contract): ok, service, name, instance ID, API 1", health.ok === true && health.service === "notflix" && health.apiVersion === 1 && health.instanceId === idA && health.name === a12.name, JSON.stringify({ ...health, instanceId: health.instanceId === idA ? "(matches)" : health.instanceId }));
  let found = await browse({ timeoutMs: 2500 });
  const mineA = found.filter((s) => s.txt?.id === idA);
  check("a _notflix._tcp query finds it with the web port and TXT app=notflix api=1 scheme=http", mineA.length > 0 && mineA.every((s) => s.port === A1.web && s.txt.app === "notflix" && s.txt.api === "1" && s.txt.scheme === "http"), JSON.stringify(mineA.map((s) => ({ name: s.name, port: s.port, txt: { ...s.txt, id: "…" } }))));
  check("no media engine port is announced", !found.some((s) => [A1.engine, A2.engine, B.engine].includes(s.port)), found.map((s) => s.port).join(","));
  const s12 = status(appA);
  check("Status-Notflix.cmd: announced, and answers a live query on the web port", /LAN discovery\s+announced as "Notflix Launcher Test A/.test(s12.out) && new RegExp(`answers test queries \\(port ${A1.web};`).test(s12.out), s12.out.match(/LAN discovery[^\n]*/g)?.join(" / "));
  const st12b = start(appB);
  const b12 = await waitAdv(B, (s) => s && s.pid === webOf(B)?.pid);
  const idB = idOf(B);
  found = await browse({ timeoutMs: 2500 });
  check("second installation (setup unfinished): running, not announced; A still announced", st12b.code === 0 && b12?.active === false && /setup/.test(b12.reason ?? "") && !found.some((s) => s.txt?.id === idB) && found.some((s) => s.txt?.id === idA && s.port === A1.web), brief(b12));
  check("stopping B leaves A's announcement alone", stop(appB).code === 0 && advStatus(A1)?.active === true && (await browse({ timeoutMs: 2500 })).some((s) => s.txt?.id === idA));
  const rs12 = restart(appA);
  const a12b = await waitAdv(A1, (s) => s?.active && s.pid !== a12.pid);
  check("restart: re-announced by the new web server, same instance ID and port", rs12.code === 0 && a12b?.active === true && a12b.pid === webOf(A1)?.pid && a12b.port === A1.web && idOf(A1) === idA, brief(a12b));
  check("…and answers queries again", (await browse({ timeoutMs: 2500 })).some((s) => s.txt?.id === idA && s.port === A1.web));
  await assertOnboarded("after restart with LAN discovery on");
  // The owner changes the port while it runs: the server moves and announces the new port.
  cli(A1, "set-port", "8565");
  const moved12 = await waitAdv(A1, (s) => s?.active && s.port === 8565);
  found = await browse({ timeoutMs: 2500 });
  check("port changed while running: the new web port is announced, the old one withdrawn", moved12?.port === 8565 && found.some((s) => s.txt?.id === idA && s.port === 8565) && !found.some((s) => s.txt?.id === idA && s.port === A1.web), brief(moved12));
  const sp12 = stop(appA);
  check("stop (after the port change): stops this installation's processes", sp12.code === 0 && /Notflix stopped/.test(sp12.out) && services(appA).length === 0);
  check("stop withdraws the announcement (status file gone, no answer)", !advStatus(A1) && !(await browse({ timeoutMs: 2500 })).some((s) => s.txt?.id === idA));
  cli(A1, "set-port", String(A1.web));
  const st12c = start(appA);
  check("start again: announced on the configured port, setup still complete", st12c.code === 0 && (await waitAdv(A1, (s) => s?.active))?.port === A1.web && lastBrowserUrl() === `${base(A1)}/`);
  check("final stop withdraws it again", stop(appA).code === 0 && !advStatus(A1) && !(await browse({ timeoutMs: 2500 })).some((s) => s.txt?.id === idA));

  section("13. One-click start: Desktop shortcut, window closes, no duplicates, recovery commands");
  const fakeDesktop = path.join(parent, "desktop");
  fs.mkdirSync(fakeDesktop, { recursive: true });
  const lnk = path.join(fakeDesktop, "Start Notflix.lnk");
  const desktopEnv = { NOTFLIX_DESKTOP_DIR: fakeDesktop };
  const psq = (s) => "'" + s.replaceAll("'", "''") + "'";
  const launcherEnv = () => ({ ...process.env, NOTFLIX_DATA_DIR: "", ProgramData: fakeProgramData, LOCALAPPDATA: path.join(parent, "localappdata"), NOTFLIX_BROWSER_LOG: browserLog });
  const setupOffer = (answer) =>
    spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(appA, "setup.ps1")], {
      input: answer + "\r\n",
      encoding: "utf8",
      env: { ...launcherEnv(), ...desktopEnv, NOTFLIX_SETUP_PROMPT: "1" },
      timeout: 15 * 60_000,
    });
  const refused = setupOffer("n");
  check("setup offers the shortcut; answering no creates nothing", refused.status === 0 && /Create a "Start Notflix" shortcut/.test(refused.stdout) && !fs.existsSync(lnk), refused.stderr?.slice(0, 200));
  const accepted = setupOffer("y");
  check("answering yes creates it", accepted.status === 0 && fs.existsSync(lnk), accepted.stderr?.slice(0, 200));
  const readLink = () =>
    JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "$l=(New-Object -ComObject WScript.Shell).CreateShortcut(" + psq(lnk) + "); @{t=$l.TargetPath;w=$l.WorkingDirectory;i=$l.IconLocation} | ConvertTo-Json"], { encoding: "utf8" }));
  const link = readLink();
  check("the shortcut starts this installation with its icon", link.t === path.join(appA, "Start-Notflix.cmd") && link.w === appA && fs.existsSync(link.i.split(",")[0]), JSON.stringify(link));

  fs.rmSync(browserLog, { force: true });
  const clickEnv = { ...launcherEnv() };
  delete clickEnv.NOTFLIX_NO_PAUSE;
  const click = () => {
    const t0 = Date.now();
    const r = spawnSync("cmd.exe", ["/d", "/c", "start", "/wait", "", lnk], { env: clickEnv, stdio: "ignore", timeout: 5 * 60_000 });
    return { code: r.status, ms: Date.now() - t0 };
  };
  const first = click();
  const afterFirst = services(appA);
  check("double-click: the window closes by itself, both services keep running", first.code === 0 && afterFirst.length === 2, JSON.stringify({ first, afterFirst: afterFirst.length }));
  check("double-click: the website answers after the window closed", (await new Client(base(A1)).json("GET", "/api/setup/status")).status === 200);
  check("double-click: the browser is opened", fs.existsSync(browserLog) && fs.readFileSync(browserLog, "utf8").includes(String(A1.web)));
  const second = click();
  const afterSecond = services(appA);
  check("second double-click: same processes, website opened again", second.code === 0 && afterSecond.map((p) => p.pid).sort().join() === afterFirst.map((p) => p.pid).sort().join() && fs.readFileSync(browserLog, "utf8").trim().split(/\r?\n/).length === 2, JSON.stringify({ second }));
  await assertOnboarded("after double-clicks");

  check("stop for recovery checks", stop(appA).code === 0);
  const fakeLocal = path.join(parent, "localappdata");
  const notAFolder = path.join(parent, "browser-opened.txt");
  const failedStart = runCmd(appA, "Start-Notflix.cmd", ["-DataDir", notAFolder], { LOCALAPPDATA: fakeLocal });
  const errorLog = path.join(fakeLocal, "NotflixDebrid", "launcher.log");
  check("a failed start stays visible (nonzero exit, message) and is logged", failedStart.code !== 0 && /Notflix did not start/.test(failedStart.out) && fs.existsSync(errorLog) && /\[start\]/.test(fs.readFileSync(errorLog, "utf8")), failedStart.out.slice(-200));

  const noOwner = path.join(A1.data, "db", "users.json");
  const usersBefore = fs.readFileSync(noOwner, "utf8");
  const claim = (name) => spawnSync(process.execPath, [path.join(appA, "scripts", "notflix-cli.mjs"), "accounts", "claim-owner", name, "--data-dir", A1.data], { encoding: "utf8", env: launcherEnv() });
  check("claim-owner refuses while an owner exists and changes nothing", claim("member").status !== 0 && fs.readFileSync(noOwner, "utf8") === usersBefore);
  const orphaned = JSON.parse(usersBefore);
  const ownerUser = orphaned.users.find((u) => u.role === "owner");
  ownerUser.role = "admin";
  fs.writeFileSync(noOwner, JSON.stringify(orphaned, null, 2));
  check("claim-owner rejects an unknown account", claim("nobody-here").status !== 0);
  const claimed = claim(ownerUser.name);
  const afterClaim = JSON.parse(fs.readFileSync(noOwner, "utf8"));
  check("claim-owner restores an owner when none exists", claimed.status === 0 && afterClaim.users.find((u) => u.name === ownerUser.name).role === "owner" && afterClaim.users.filter((u) => u.role === "owner").length === 1, claimed.stderr?.slice(0, 200));

  const refresh = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(appA, "scripts", "notflix.ps1"), "refresh", "-NoBrowser"], { env: launcherEnv(), stdio: "ignore", timeout: 15 * 60_000 });
  check("refresh rebuilds and restarts", refresh.status === 0 && services(appA).length === 2);
  await assertOnboarded("after refresh");
  const noGit = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(appA, "scripts", "notflix.ps1"), "redeploy"], { env: launcherEnv(), encoding: "utf8" });
  check("redeploy without Git explains itself and leaves Notflix running", noGit.status !== 0 && /not a Git clone/.test(noGit.stdout + noGit.stderr) && services(appA).length === 2);
  check("stop after recovery checks", stop(appA).code === 0);
} catch (err) {
  check("test ran to completion", false, err instanceof Error ? err.stack : String(err));
} finally {
  section("Cleanup");
  for (const app of [appA, appB]) if (fs.existsSync(path.join(app, "Stop-Notflix.cmd"))) stop(app, ["-All"]);
  for (const d of decoys) {
    try {
      process.kill(d.pid);
    } catch {
      /* gone */
    }
  }
  await sleep(1000);
  check("no process from the test folders left", underParent().length === 0, JSON.stringify(underParent().map((p) => p.pid)));
  check("Notflix processes of other folders (e.g. on 8420/8421) still running", foreignBefore.every((p) => alive(p.pid)), `${foreignBefore.length} checked`);
  if (!keep) for (const d of [A1.data, A2.data, B.data, path.join(parent, "data new"), path.join(parent, "decoy")]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log("Failed:\n  " + failures.join("\n  "));
process.exit(failures.length ? 1 : 0);
