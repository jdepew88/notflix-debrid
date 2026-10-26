#!/usr/bin/env node
/**
 * End-to-end check of a FRESH installation against a running Notflix (web + media engine):
 *
 *   node scripts/test-install-e2e.mjs --base http://localhost:8520 --data <data folder> [--phase all|restart]
 *
 * 1. First-run setup over HTTP exactly as the wizard does it: setup code, server settings, owner
 *    account (twice at once: only one may win), owner-only access, setup refusal afterwards.
 * 2. Provider validation against the REAL TMDB and Real-Debrid APIs with deliberately invalid
 *    credentials (they must be rejected and not stored).
 * 3. SIMULATED valid providers: with no real accounts available to the test, it writes placeholder
 *    credentials and "validated" markers into the data folder, then completes setup. (Clearly a
 *    simulation; no catalog browsing or Real-Debrid playback is exercised by this script.)
 * 4. Authorized playback of the generated sample videos through the authenticated relay in every
 *    mode the engine plans for this hardware (Direct Play, remux, audio-only, video transcode with
 *    each verified backend and software), output verified with ffprobe; session termination;
 *    unauthenticated and cross-account access refused.
 * 5. --phase restart: after the launcher restarted Notflix, sign in again and check that the
 *    configuration, accounts and profiles persisted.
 *
 * The data folder must be a throwaway one (the script writes into it). Never point this at a real install.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readSecrets, secretsStatus, updateSecrets } from "../src/lib/install/secrets.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const base = opt("--base", "http://localhost:8520").replace(/\/$/, "");
const dataDir = opt("--data");
const phase = opt("--phase", "all");
if (!dataDir) {
  console.error("--data <throwaway data folder> is required");
  process.exit(2);
}
const statePath = path.join(dataDir, "e2e-state.json");

let passed = 0;
const failures = [];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

class Client {
  constructor() {
    this.jar = new Map();
  }
  async req(method, url, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1);
      if (/max-age=0/i.test(c) || v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async json(method, url, body) {
    const res = await this.req(method, url, body);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, res };
  }
}

function ffprobe(file) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
}

/** Fetches init + first segments of an HLS session through Notflix and checks them with ffprobe. */
async function verifyHls(client, manifestUrl, label) {
  const m = await client.req("GET", manifestUrl);
  const text = await m.text();
  if (m.status !== 200 || !text.startsWith("#EXTM3U")) return { ok: false, detail: `manifest ${m.status}` };
  const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
  const init = /URI="([^"]+)"/.exec(text)?.[1];
  const dir = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  const parts = [];
  for (const u of [init, ...lines.slice(0, 2)].filter(Boolean)) {
    const r = await client.req("GET", u.startsWith("/") ? u : dir + u.replace(/^\.\//, ""));
    if (r.status !== 200) return { ok: false, detail: `segment ${r.status}` };
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  const file = path.join(os.tmpdir(), `notflix-e2e-${label.replace(/\W+/g, "_")}.mp4`);
  fs.writeFileSync(file, Buffer.concat(parts));
  const probe = ffprobe(file);
  fs.rmSync(file, { force: true });
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  return { ok: Boolean(v), detail: `${v?.codec_name ?? "no video"} ${v?.width ?? "?"}x${v?.height ?? "?"}${a ? ` + ${a.codec_name}` : ""}` };
}

async function setupPhase() {
  const owner = new Client();
  const stranger = new Client();
  console.log("\n# 1. First-run setup");
  const home = await stranger.req("GET", "/");
  check("fresh install redirects every page to /setup", home.status === 307 && /\/setup$/.test(home.headers.get("location") ?? ""), `${home.status} → ${home.headers.get("location")}`);
  const status0 = (await stranger.json("GET", "/api/setup/status")).data;
  check("status: not set up, no owner", status0.setupComplete === false && status0.ownerExists === false);
  const usersFile = path.join(dataDir, "db", "users.json");
  check("empty database (no accounts file yet)", !fs.existsSync(usersFile) || JSON.parse(fs.readFileSync(usersFile, "utf8")).users.length === 0);
  check("protected config without setup code → 401", (await stranger.json("GET", "/api/config/server")).status === 401);
  check("wrong setup code → 401", (await stranger.json("POST", "/api/setup/unlock", { code: "AAAA-BBBB-CCCC" })).status === 401);
  const code = fs.readFileSync(path.join(dataDir, "setup-code.txt"), "utf8").trim();
  check("setup code accepted", (await owner.json("POST", "/api/setup/unlock", { code })).status === 200);
  const srv = await owner.json("PUT", "/api/config/server", { hostname: "media-pc.local", cacheMaxGiB: 15 });
  check("server settings saved (local-only, cache 15 GB)", srv.status === 200 && srv.data.server.allowLan === false && srv.data.storage.cacheMaxGiB === 15, `bind ${srv.data.server?.effectiveBindAddress}`);
  const badCache = await owner.json("PUT", "/api/config/server", { cacheDirectory: path.join(dataDir, "secrets") });
  check("cache folder inside secrets refused", badCache.status === 400 && Boolean(badCache.data.errors?.cacheDirectory));

  // Two owner requests at once with the same setup session: exactly one may succeed.
  const other = new Client();
  other.jar = new Map(owner.jar);
  const [a, b] = await Promise.all([
    owner.json("POST", "/api/setup/owner", { name: "owner", displayName: "Test Owner", password: "correct-horse-1", confirm: "correct-horse-1" }),
    other.json("POST", "/api/setup/owner", { name: "intruder", password: "correct-horse-2", confirm: "correct-horse-2" }),
  ]);
  const statuses = [a.status, b.status].sort();
  check("concurrent owner creation: exactly one succeeds", statuses[0] === 200 && statuses[1] === 409, `statuses ${statuses.join(",")}`);
  const winner = a.status === 200 ? owner : other;
  if (winner !== owner) owner.jar = new Map(other.jar);
  const users = JSON.parse(fs.readFileSync(usersFile, "utf8")).users;
  check("one owner in the database, password hashed", users.filter((u) => u.role === "owner").length === 1 && users.every((u) => /^scrypt\$/.test(u.passwordHash)) && !fs.readFileSync(usersFile, "utf8").includes("correct-horse"));
  check("setup code deleted after owner creation", !fs.existsSync(path.join(dataDir, "setup-code.txt")));
  check("owner creation refused afterwards", (await stranger.json("POST", "/api/setup/owner", { name: "late", password: "password-9", confirm: "password-9" })).status === 409);

  console.log("\n# 2. Provider validation (real APIs, invalid credentials)");
  const tmdb = await owner.json("PUT", "/api/config/metadata", { tmdbApiKey: "0123456789abcdef0123456789abcdef" });
  check("real TMDB rejects an invalid key; not stored", tmdb.status === 400 && tmdb.data.tmdb?.configured === false, tmdb.data.error);
  const rd = await owner.json("PUT", "/api/config/debrid", { token: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOP" });
  check("real Real-Debrid rejects an invalid token; not stored", rd.status === 400 && rd.data.configured === false, rd.data.error);
  const stored = readSecrets(dataDir);
  check("rejected credentials absent from the secret store", !stored.tmdbApiKey && !stored.realDebridToken);
  const status = secretsStatus(dataDir);
  check("credential store encrypted at rest", process.platform !== "win32" || (status.protection === "dpapi-user" && status.state === "ok"), status.label);

  console.log("\n# 3. Hardware (real detection on this machine)");
  const hw = await owner.json("GET", "/api/config/hardware?refresh=1");
  const caps = hw.data.engine?.capabilities;
  check("engine online and FFmpeg found", hw.data.engine?.online === true && caps?.ffmpeg?.available === true, `FFmpeg ${caps?.ffmpeg?.version}`);
  const verified = (caps?.backends ?? []).filter((x) => x.status === "verified").map((x) => x.id);
  console.log(`    adapters: ${(caps?.adapters ?? []).map((x) => `${x.name}${x.virtual ? " (virtual)" : ""}`).join("; ")}`);
  for (const bk of caps?.backends ?? []) {
    console.log(`    ${bk.id.padEnd(12)} ${bk.status.padEnd(11)} enc ${JSON.stringify(bk.encoders)} dec ${JSON.stringify(bk.decoders)}`);
  }
  console.log(`    selection: ${JSON.stringify(caps?.selection)}`);
  const hwSave = await owner.json("PUT", "/api/config/hardware", { hardwareAcceleration: "auto", maxConcurrentTranscodes: 2 });
  check("hardware choice saved", hwSave.status === 200);
  check("invalid device refused", (await owner.json("PUT", "/api/config/hardware", { hardwareDevice: "gpu0; del" })).status === 400);

  console.log("\n# 3b. SIMULATED provider validation (no real accounts in this test)");
  const incomplete = await owner.json("POST", "/api/setup/complete", {});
  check("completion refused while TMDB/Real-Debrid are missing", incomplete.status === 409, (incomplete.data.missing ?? []).map((m) => m.id).join(","));
  // Placeholder credentials + validation markers, written the way the server stores them.
  updateSecrets(dataDir, { tmdbApiKey: "SIMULATED-TMDB-KEY-NOT-REAL", realDebridToken: "SIMULATEDREALDEBRIDTOKENNOTREAL0000" });
  const onDisk = fs.readFileSync(path.join(dataDir, "secrets", "secrets.json"), "utf8");
  check("credentials not readable in the file on disk", process.platform !== "win32" || (!onDisk.includes("SIMULATED-TMDB") && !onDisk.includes("SIMULATEDREALDEBRID")));
  const cfgFile = path.join(dataDir, "config", "server.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.metadata.tmdbValidatedAt = new Date().toISOString();
  cfg.debrid.validatedAt = new Date().toISOString();
  cfg.debrid.account = "simulated";
  cfg.setup.stepsDone = [...new Set([...cfg.setup.stepsDone, "metadata", "debrid"])];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const done = await owner.json("POST", "/api/setup/complete", {});
  check("setup completes once requirements are met", done.status === 200, done.data.error ?? "");
  check("setup cannot be restarted", (await stranger.json("POST", "/api/setup/unlock", { code })).status === 409 && (await owner.json("POST", "/api/setup/complete", {})).status === 409);
  const setupPage = await stranger.req("GET", "/setup");
  check("/setup redirects away after completion", setupPage.status === 307 && !/\/setup$/.test(setupPage.headers.get("location") ?? ""));
  const summary = (await owner.json("GET", "/api/config/summary")).data;
  check("summary never contains credentials", !JSON.stringify(summary).includes("SIMULATED-TMDB-KEY") && !JSON.stringify(summary).includes("SIMULATEDREALDEBRID"));

  console.log("\n# 4. Accounts and authorization");
  const create = await owner.json("POST", "/api/admin/users", { action: "create", name: "member", password: "member-pass-1" });
  check("owner creates a member account", create.status === 200);
  check("self sign-up closed by default", (await stranger.json("POST", "/api/auth/signup", { name: "stranger", password: "stranger-1" })).status === 403);
  const member = new Client();
  check("member signs in", (await member.json("POST", "/api/auth/login", { name: "member", password: "member-pass-1" })).status === 200);
  check("member cannot read credentials/config", (await member.json("GET", "/api/config/debrid")).status === 403 && (await member.json("GET", "/api/config/server")).status === 403);
  check("member cannot change playback defaults", (await member.json("POST", "/api/settings/sync", { maxResolution: 480 })).status === 403);
  check("anonymous API access refused", (await stranger.json("GET", "/api/catalog?type=trending")).status === 401);

  console.log("\n# 5. Authorized playback of self-test samples");
  const samples = (await owner.json("GET", "/api/playback/sample")).data.samples ?? [];
  check("self-test samples available", samples.length > 0, `${samples.length} files`);
  const browser = { directVideo: ["h264"], directAudio: ["aac", "mp3"], mseVideo: ["h264"], mseAudio: ["aac", "mp3"], tenBit: [] };
  const cases = [
    { name: "h264_aac.mp4", expect: "DirectPlay" },
    { name: "h264_aac.mkv", expect: "Remux" },
    { name: "h264_ac3_gop10_long.mkv", expect: "AudioTranscode" },
    { name: "hevc_ac3.mkv", expect: "VideoTranscode" },
  ].filter((c) => samples.some((s) => s.name === c.name));
  let firstSession = null;
  for (const c of cases) {
    const r = await owner.json("POST", "/api/playback/sample", { name: c.name, client: browser });
    const s = r.data.session;
    const mode = s?.mode;
    const pipeline = s?.decision?.pipeline ?? "";
    if (!firstSession && s) firstSession = { id: s.id, url: r.data.urls.manifest ?? r.data.urls.stream };
    if (mode === "DirectPlay") {
      const head = await owner.req("GET", r.data.urls.stream, undefined, { range: "bytes=0-65535" });
      check(`${c.name}: Direct Play`, mode === c.expect && head.status === 206, `range ${head.status}, ${head.headers.get("content-type")}`);
    } else {
      const v = r.data.urls?.manifest ? await verifyHls(owner, r.data.urls.manifest, c.name) : { ok: false, detail: r.data.error };
      check(`${c.name}: ${c.expect}${pipeline ? ` via ${pipeline}` : ""}`, mode === c.expect && v.ok, v.detail);
    }
    if (s && s !== firstSession) await owner.req("DELETE", `/api/playback/${s.id}`);
  }

  // Every verified backend plus the processor, forced on the HEVC sample.
  for (const backend of [...verified.filter((x) => x !== "d3d11va"), "off"]) {
    await owner.json("PUT", "/api/config/hardware", { hardwareAcceleration: backend });
    const r = await owner.json("POST", "/api/playback/sample", { name: "hevc_ac3.mkv", client: browser });
    const s = r.data.session;
    const v = r.data.urls?.manifest ? await verifyHls(owner, r.data.urls.manifest, `hevc-${backend}`) : { ok: false, detail: r.data.error };
    const pipeline = (await owner.json("GET", `/api/playback/${s?.id}/metrics`)).data?.processing?.pipeline ?? s?.decision?.pipeline;
    const expectWord = { nvenc: "NVENC", amf: "AMF", qsv: "QSV", vaapi: "VAAPI", videotoolbox: "VideoToolbox", off: "x264" }[backend];
    check(`video transcode with ${backend === "off" ? "software only" : backend}`, v.ok && String(pipeline).includes(expectWord), `${pipeline}; ${v.detail}`);
    if (s) await owner.req("DELETE", `/api/playback/${s.id}`);
  }
  await owner.json("PUT", "/api/config/hardware", { hardwareAcceleration: "auto" });

  if (firstSession) {
    check("another account cannot use the session", (await member.req("GET", firstSession.url)).status >= 400);
    check("anonymous cannot use the session", (await stranger.req("GET", firstSession.url)).status === 401);
    const del = await owner.req("DELETE", `/api/playback/${firstSession.id}`);
    const after = await owner.req("GET", firstSession.url);
    check("session terminated on request", del.status < 300 && after.status >= 400, `delete ${del.status}, then ${after.status}`);
  }

  fs.writeFileSync(statePath, JSON.stringify({ ownerName: "owner", ownerPassword: a.status === 200 ? "correct-horse-1" : "correct-horse-2" }));
}

async function restartPhase() {
  console.log("\n# 6. After restart");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const owner = new Client();
  const login = await owner.json("POST", "/api/auth/login", { name: state.ownerName, password: state.ownerPassword });
  check("owner signs in after restart", login.status === 200 && login.data.user?.role === "owner");
  const status = (await owner.json("GET", "/api/setup/status")).data;
  check("setup still complete", status.setupComplete === true);
  const srv = (await owner.json("GET", "/api/config/server")).data;
  check("server settings persisted", srv.server?.hostname === "media-pc.local" && srv.storage?.cacheMaxGiB === 15);
  const hw = (await owner.json("GET", "/api/config/hardware")).data;
  check("hardware settings persisted", hw.settings?.maxConcurrentTranscodes === 2);
  const creds = readSecrets(dataDir);
  check("encrypted credentials readable after restart", creds.tmdbApiKey === "SIMULATED-TMDB-KEY-NOT-REAL" && creds.realDebridToken.startsWith("SIMULATEDREALDEBRID"));
  const summary = (await owner.json("GET", "/api/config/summary")).data;
  check("summary reports the protection, no values", /DPAPI|permissions/.test(summary.summary?.credentials?.label ?? summary.credentials?.label ?? "") && !JSON.stringify(summary).includes("SIMULATED"));
  const me = (await owner.json("GET", "/api/auth/me")).data;
  check("profiles persisted", (me.state?.profiles ?? []).length >= 2, (me.state?.profiles ?? []).map((p) => p.name).join(", "));
  const member = new Client();
  check("member account persisted", (await member.json("POST", "/api/auth/login", { name: "member", password: "member-pass-1" })).status === 200);
}

try {
  if (phase === "all") await setupPhase();
  else await restartPhase();
} catch (err) {
  check("script ran without errors", false, err instanceof Error ? err.stack : String(err));
}
fs.appendFileSync(path.join(dataDir, "e2e-results.json"), JSON.stringify({ phase, at: new Date().toISOString(), results }) + "\n");
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
