#!/usr/bin/env node
/**
 * Live Real-Debrid → media engine check through the real Notflix API (needs the owner to have connected Real-Debrid in setup).
 *   node scripts/test-live-debrid.mjs <baseUrl> <account> <password> [tmdbId] [type] [season] [episode]
 * Defaults to a public-domain film (Night of the Living Dead, 1968 — TMDB 10331).
 * Verifies: source search, RD link resolution, engine probe/decision, and that media bytes flow.
 */
import { CLIENTS } from "./lib/engine-client.mjs";

const [base = "http://127.0.0.1:8420", account, password, tmdbId = "10331", type = "movie", season, episode] = process.argv.slice(2);
if (!account || !password) {
  console.error("usage: node scripts/test-live-debrid.mjs <baseUrl> <account> <password> [tmdbId] [type] [season] [episode]");
  process.exit(2);
}
const jar = new Map();
const call = async (path, init = {}) => {
  const res = await fetch(base + path, { ...init, headers: { ...(init.headers || {}), Cookie: [...jar.values()].join("; ") } });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (name === "notflix_session" || name === "notflix_profile") jar.set(name, pair);
  }
  return res;
};

const login = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: account, password }) });
if (!login.ok) {
  console.error("login failed", login.status);
  process.exit(1);
}
// Like a browser: pick a profile (the first one without maturity restrictions). Without one the
// strictest profile's rules apply and unrated titles are hidden.
const me = await (await call("/api/auth/me")).json();
const profile = me.state.profiles.find((p) => !p.isKids && (!p.maturity || p.maturity === "all")) ?? me.state.profiles[0];
const selected = await call("/api/user/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select", profileId: profile.id }) });
if (!selected.ok) {
  console.error(`could not select profile "${profile.name}" (${selected.status}); a PIN-protected profile cannot be used here`);
  process.exit(1);
}
const status = await (await call("/api/settings/debrid-status?fresh=1")).json();
console.log("Real-Debrid account:", status.status, "-", status.message);

const srcRes = await call(`/api/playback/sources?tmdbId=${tmdbId}&type=${type}${season ? `&season=${season}&episode=${episode}` : ""}&hevc=1`);
const src = await srcRes.json();
console.log(`
Sources (${src.candidates?.length ?? 0} releases, preferred ${src.preferred?.join(",")}):`);
for (const c of (src.candidates ?? []).slice(0, 6)) {
  const v = c.verified;
  console.log(`   #${c.index} ${c.cached ? "⚡" : "⬇"} ${c.label.slice(0, 70)} | hints: ${c.hints.codes.join(",") || "none"}${c.hints.likelyNonEnglishOnly ? " (likely non-English)" : ""} | ${v ? `verified audio: ${v.audioLanguages.join(",") || "untagged"}` : "unverified"}`);
}
for (const [label, client] of process.env.LIVE_STREAM_INDEX ? [["Chrome on Windows (HEVC capable)", CLIENTS.chromeWindows]] : [["Chrome on Windows (HEVC capable)", CLIENTS.chromeWindows], ["H.264-only device", CLIENTS.h264Only]]) {
  const t0 = Date.now();
  const res = await call("/api/playback/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tmdbId: Number(tmdbId), type, season: season ? Number(season) : undefined, episode: episode ? Number(episode) : undefined, watchId: `tmdb-${tmdbId}`, client, streamIndex: process.env.LIVE_STREAM_INDEX ? Number(process.env.LIVE_STREAM_INDEX) : undefined }),
  });
  const data = await res.json();
  const ms = Date.now() - t0;
  if (!data.ok) {
    console.log(`\n[${label}] FAILED in ${ms} ms: ${data.error} (${data.code})`);
    for (const d of data.details ?? []) console.log("   -", d);
    continue;
  }
  const s = data.session;
  console.log(`\n[${label}] ${data.provider} · ${data.streamLabel} · ${data.quality ?? ""}`);
  console.log(`   total ${ms} ms (server: search ${data.timing.resolveMs} ms, RD link ${data.timing.linkMs} ms, engine ${data.timing.engineMs} ms; candidates tried ${data.candidatesTried})`);
  console.log(`   source: ${s.source.container} ${s.source.video?.codec} ${s.source.video?.width}x${s.source.video?.height} ${s.source.video?.dynamicRange}, audio ${s.source.audio?.map((a) => a.codec).join("/")}, ${(s.source.fileSize / 1e9).toFixed(2)} GB`);
  console.log(`   decision: ${s.modeLabel}${s.decision.pipeline ? ` via ${s.decision.pipeline}` : ""} → ${s.decision.outputVideoCodec}/${s.decision.outputAudioCodec} (${s.decision.reasons.join("; ")})`);
  console.log(`   audio: tracks [${s.tracks.audio.map((a) => `${a.languageCode ?? "unknown"}:${a.codec}${a.channels}ch`).join(", ")}] → selected ${data.audio?.selectedLanguage ?? "unknown"} (preferred ${data.audio?.preferred.join(",")}; matched ${data.audio?.matched}); candidates ${data.candidates}, alternatives with language ${data.alternativesWithLanguage}; probe stage ${data.timing.probeMs ?? 0} ms`);
  if (data.notices?.length) console.log(`   notices: ${data.notices.join(" | ")}`);

  // Pull real media bytes through Notflix's proxy.
  const t1 = Date.now();
  if (s.output === "hls") {
    const m = await call(`/api/playback/${s.id}/manifest?generation=${s.generation}`);
    const text = await m.text();
    const seg = text.split("\n").find((l) => l && !l.startsWith("#"));
    const init = /URI="([^"]+)"/.exec(text)?.[1];
    const a = await call(`/api/playback/${s.id}/${init}`);
    const b = await call(`/api/playback/${s.id}/${seg}`);
    const bytes = (await a.arrayBuffer()).byteLength + (await b.arrayBuffer()).byteLength;
    console.log(`   media: manifest ${m.status}, init+first segment ${bytes} bytes in ${Date.now() - t1} ms`);
  } else {
    const r = await call(`/api/playback/${s.id}/stream`, { headers: { Range: "bytes=0-4194303" } });
    const bytes = (await r.arrayBuffer()).byteLength;
    console.log(`   media: ${r.status} ${r.headers.get("content-range")} — ${bytes} bytes in ${Date.now() - t1} ms (${((bytes * 8) / 1e6 / ((Date.now() - t1) / 1000)).toFixed(1)} Mbps)`);
  }
  await call(`/api/playback/${s.id}`, { method: "DELETE" });
}
