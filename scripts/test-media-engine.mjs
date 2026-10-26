#!/usr/bin/env node
/**
 * Media engine integration matrix (real FFmpeg). Exercises a running engine with the generated
 * samples in test-media/ and verifies the decision, the actual output codecs (ffprobe on produced
 * segments), hardware encoder use, seeking, throttling, cancellation/cleanup, network interruption
 * recovery, expired sources, subtitle extraction and audio-track switching.
 *
 * Expected pipelines follow the engine's *effective* backend (GET /capabilities → selection), so the
 * same matrix runs on NVIDIA, AMD, Intel, VAAPI, VideoToolbox or CPU-only machines.
 *
 *   node scripts/generate-test-media.mjs
 *   node scripts/test-media-engine.mjs [--only name] [--hwaccel auto|nvenc|qsv|amf|vaapi|videotoolbox|off]
 *
 * Environment:
 *   ENGINE_URL           engine to test (default http://127.0.0.1:8421)
 *   MEDIA_ENGINE_SECRET  shared secret, or NOTFLIX_DATA_DIR (reads <data>/secrets/engine-secret)
 *   SECOND_ENGINE_PORT   port for the network-test engine this script starts (default 8522)
 *   MATRIX_OUT_DIR       where results go (default test-results/)
 *
 * --hwaccel switches the engine via POST /config for the run and restores the previous value after.
 * Writes <out>/media-engine-matrix[-<hwaccel>].{json,md}.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CLIENTS, engine, readEngineSecret, repoRoot } from "./lib/engine-client.mjs";

const env = process.env;
const ENGINE_URL = (env.ENGINE_URL || env.MEDIA_ENGINE_URL || "http://127.0.0.1:8421").replace(/\/$/, "");
const SECRET = readEngineSecret(env);
if (!SECRET) {
  console.error("Engine secret missing: set MEDIA_ENGINE_SECRET or NOTFLIX_DATA_DIR (reads <data>/secrets/engine-secret).");
  process.exit(2);
}
const argValue = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const media = (f) => path.join(repoRoot, "test-media", f);
const only = argValue("--only");
const HWACCEL = argValue("--hwaccel") ?? env.ENGINE_HWACCEL ?? null;
const e = engine({ url: ENGINE_URL, secret: SECRET });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-matrix-"));

// --- Backend under test ------------------------------------------------------------------------
let previousHwaccel = null;
if (HWACCEL) {
  const before = await e.call("GET", "/capabilities");
  previousHwaccel = before.json?.limits?.hardwareAcceleration ?? "auto";
  const r = await e.call("POST", "/config", { body: { hardwareAcceleration: HWACCEL } });
  if (r.status !== 200) {
    console.error(`POST /config hardwareAcceleration=${HWACCEL} → ${r.status} ${JSON.stringify(r.json)}`);
    process.exit(2);
  }
}
const CAPS = (await e.call("GET", "/capabilities")).json;
const BACKEND = CAPS?.selection?.effective ?? (CAPS?.encoders?.verified?.includes("h264_nvenc") ? "nvenc" : "software");
const SHORT = { nvenc: "NVENC", qsv: "QSV", amf: "AMF", vaapi: "VAAPI", videotoolbox: "VideoToolbox" };
const backendReport = (id) => CAPS?.backends?.find((b) => b.id === id);
const decodeLabel = (id) =>
  id === "nvenc" ? "NVDEC"
  : id === "vaapi" ? "VAAPI"
  : id === "videotoolbox" ? "VideoToolbox"
  : CAPS?.platform?.os === "windows" ? "D3D11VA" : "VAAPI";
console.log(`Engine ${ENGINE_URL}: requested ${CAPS?.selection?.requested ?? "?"} → effective backend ${BACKEND}` +
  (CAPS?.selection?.fallbackReason ? ` (${CAPS.selection.fallbackReason})` : ""));

/** Pipeline label the engine should pick for a source codec on the effective backend. */
function expectedPipeline(codec, { hwDecode = true } = {}) {
  if (BACKEND === "software") return "CPU decode + x264";
  const enc = `${SHORT[BACKEND]} H.264`;
  const decoded = hwDecode && backendReport(BACKEND)?.decoders?.[codec] === "verified";
  return decoded ? `${decodeLabel(BACKEND)} + ${enc}` : `CPU decode + ${enc}`;
}
/** Tone mapping the first rung uses for HDR sources. */
const expectedTonemap = () =>
  BACKEND === "software" || BACKEND === "vaapi" || !CAPS?.tonemapping?.libplacebo ? "Cpu" : "Libplacebo";

function ffprobeJson(file) {
  const r = spawnSync(env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

/** Downloads init + first N media segments of the current generation and ffprobes them. */
async function inspectHlsOutput(session, count = 2) {
  const m = await e.call("GET", `/sessions/${session.id}/manifest`, { session });
  if (m.status !== 200) throw new Error(`manifest ${m.status} ${JSON.stringify(m.json)}`);
  const text = m.json.text;
  const lines = text.split("\n");
  const init = /URI="([^"]+)"/.exec(lines.find((l) => l.startsWith("#EXT-X-MAP")) ?? "")?.[1];
  const segs = lines.filter((l) => l && !l.startsWith("#")).slice(0, count);
  const parts = [];
  for (const uri of [init, ...segs]) {
    const res = await e.call("GET", `/sessions/${session.id}/${uri}`, { session, raw: true });
    if (res.status !== 200) throw new Error(`${uri} → ${res.status}`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  const file = path.join(tmpDir, `${session.id}.mp4`);
  fs.writeFileSync(file, Buffer.concat(parts));
  const probe = ffprobeJson(file);
  const v = probe?.streams?.find((s) => s.codec_type === "video");
  const a = probe?.streams?.find((s) => s.codec_type === "audio");
  return {
    playlistSegments: lines.filter((l) => l.startsWith("#EXTINF")).length,
    videoCodec: v?.codec_name, width: v?.width, height: v?.height, pixFmt: v?.pix_fmt, colorTransfer: v?.color_transfer,
    audioCodec: a?.codec_name, audioChannels: a?.channels,
    startTime: probe?.format?.start_time ? Number(probe.format.start_time) : null,
    bytes: parts.reduce((n, p) => n + p.length, 0),
  };
}

async function closeSession(s) {
  if (s) await e.call("DELETE", `/sessions/${s.id}`, { session: s });
}

class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  const record = { name, ok: false, ms: 0, details: {} };
  try {
    await fn(record.details);
    record.ok = true;
  } catch (err) {
    if (err instanceof Skip) {
      record.ok = true;
      record.skipped = err.message;
    } else record.error = err instanceof Error ? err.message : String(err);
  }
  record.ms = Date.now() - started;
  results.push(record);
  const label = record.skipped ? "SKIP" : record.ok ? "PASS" : "FAIL";
  const note = record.error ?? record.skipped;
  console.log(`${label}  ${name.padEnd(64)} ${String(record.ms).padStart(6)} ms${note ? `  — ${note}` : ""}`);
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function create(file, client, opts = {}) {
  const t0 = Date.now();
  const r = await e.createSession({ kind: "file", path: media(file), provider: "sample", fileName: file }, { client, ...opts });
  if (r.status !== 201) throw new Error(`create ${r.status}: ${JSON.stringify(r.json)}`);
  return { session: r.json, createMs: Date.now() - t0 };
}

/** Codec matrix: file × client → expected mode and output codecs (pipelines follow the effective backend). */
const matrix = [
  { name: "1. H.264+AAC MP4 → Direct Play", file: "h264_aac.mp4", client: "chromeWindows", mode: "DirectPlay" },
  { name: "1b. H.264+AAC MKV → Remux (copy/copy)", file: "h264_aac.mkv", client: "chromeWindows", mode: "Remux", video: "h264", audio: "aac" },
  { name: "2. H.264+DTS MKV → Audio transcode (video copied)", file: "h264_dts.mkv", client: "chromeWindows", mode: "AudioTranscode", video: "h264", audio: "aac", videoAction: "Copy" },
  { name: "3. HEVC+AC-3 MKV, HEVC browser → Audio transcode", file: "hevc_ac3.mkv", client: "chromeWindows", mode: "AudioTranscode", video: "hevc", audio: "aac" },
  { name: "3b. HEVC+AC-3 MKV, no-HEVC browser → HW decode + HW encode", file: "hevc_ac3.mkv", client: "noHevc", mode: "VideoTranscode", video: "h264", audio: "aac", pipeline: () => expectedPipeline("hevc") },
  { name: "4. HEVC10+TrueHD MKV, HEVC browser → Audio transcode", file: "hevc10_truehd.mkv", client: "chromeWindows", mode: "AudioTranscode", video: "hevc", audio: "aac" },
  { name: "4b. HEVC10+TrueHD MKV, no-HEVC → HW transcode (10→8 bit)", file: "hevc10_truehd.mkv", client: "noHevc", mode: "VideoTranscode", video: "h264", audio: "aac", pixFmt: "yuv420p", pipeline: () => expectedPipeline("hevc") },
  { name: "5. AV1+Opus WebM → Direct Play", file: "av1_opus.webm", client: "chromeWindows", mode: "DirectPlay" },
  { name: "5b. AV1+AAC MP4 → Direct Play", file: "av1_aac.mp4", client: "chromeWindows", mode: "DirectPlay" },
  { name: "5c. AV1 MP4, H.264-only device → HW AV1 decode + HW encode", file: "av1_aac.mp4", client: "h264Only", mode: "VideoTranscode", video: "h264", audio: "aac", pipeline: () => expectedPipeline("av1") },
  { name: "6. 4K HEVC10 HDR10, no-HEVC → H.264 + tone map", file: "hevc10_hdr10_2160p.mkv", client: "noHevc", mode: "VideoTranscode", video: "h264", height: 2160, transfer: "bt709", tonemap: expectedTonemap },
  { name: "6b. 4K HDR10 with 1080p limit → scaled + tone mapped", file: "hevc10_hdr10_2160p.mkv", client: "h264Only", mode: "VideoTranscode", video: "h264", height: 1080, transfer: "bt709", prefs: { maxHeight: 1080 } },
  { name: "6c. 4K HDR10, HEVC browser → Audio transcode (E-AC-3)", file: "hevc10_hdr10_2160p.mkv", client: "chromeWindows", mode: "AudioTranscode", video: "hevc", audio: "aac", height: 2160 },
  { name: "7. Unsupported audio (MP2) in TS + MPEG-2 → full transcode", file: "mpeg2_mp2.ts", client: "chromeWindows", mode: "VideoTranscode", video: "h264", audio: "aac", pipeline: () => expectedPipeline("mpeg2video") },
  { name: "7b. MPEG-4 ASP AVI → video transcode, MP3 copied", file: "mpeg4_mp3.avi", client: "chromeWindows", mode: "VideoTranscode", video: "h264", audio: "mp3", pipeline: () => expectedPipeline("mpeg4") },
  { name: "7c. VP9+Opus WebM → Direct Play", file: "vp9_opus.webm", client: "chromeWindows", mode: "DirectPlay" },
  { name: "7d. H.264 Hi10P → CPU decode + HW encode (no Hi10P decoders)", file: "h264_hi10_aac.mkv", client: "chromeWindows", mode: "VideoTranscode", video: "h264", pixFmt: "yuv420p", pipeline: () => expectedPipeline("h264", { hwDecode: false }) },
  { name: "8. CPU fallback (hardware acceleration off) → x264", file: "mpeg4_mp3.avi", client: "chromeWindows", mode: "VideoTranscode", video: "h264", pipeline: () => "CPU decode + x264", prefs: { hardwareAcceleration: "off" } },
];

await test("engine health + verified capabilities", async (d) => {
  const h = await fetch(`${ENGINE_URL}/health`).then((r) => r.json());
  expect(h.status === "ok", "health not ok");
  const c = await e.call("GET", "/capabilities");
  expect(c.status === 200, `capabilities ${c.status}`);
  d.gpu = c.json.gpu.name;
  d.backend = c.json.selection?.effective;
  d.encoders = c.json.encoders.verified;
  d.hwDecoders = c.json.hardwareDecoders.verified;
  d.libplacebo = c.json.tonemapping.libplacebo;
  d.backends = Object.fromEntries((c.json.backends ?? []).map((b) => [b.id, b.status]));
  expect(c.json.ffmpeg?.available === true, "engine reports ffmpeg unavailable");
  expect(Array.isArray(c.json.adapters) && Array.isArray(c.json.backends), "capabilities lack adapters/backends");
  const unauth = await fetch(`${ENGINE_URL}/capabilities`);
  expect(unauth.status === 401, "capabilities must require the engine key");
});

for (const c of matrix) {
  await test(c.name, async (d) => {
    const { session, createMs } = await create(c.file, CLIENTS[c.client], { preferences: c.prefs });
    try {
      d.createMs = createMs;
      d.mode = session.mode;
      d.pipeline = session.decision.pipeline;
      d.reasons = session.decision.reasons;
      expect(session.mode === c.mode, `expected ${c.mode}, got ${session.mode} (${session.decision.reasons.join("; ")})`);
      if (c.pipeline) {
        const want = c.pipeline();
        expect(session.decision.pipeline === want, `expected pipeline ${want}, got ${session.decision.pipeline}`);
      }
      if (c.videoAction) expect(session.decision.video === c.videoAction, `video action ${session.decision.video}`);
      if (c.tonemap) expect(session.decision.tonemap === c.tonemap(), `tonemap ${session.decision.tonemap}, expected ${c.tonemap()}`);
      if (session.output === "progressive") {
        const res = await e.call("GET", `/sessions/${session.id}/stream`, { session, raw: true, headers: { Range: "bytes=0-65535" } });
        expect(res.status === 206, `range request → ${res.status}`);
        d.contentRange = res.headers.get("content-range");
        d.contentType = res.headers.get("content-type");
        await res.arrayBuffer();
        return;
      }
      const out = await inspectHlsOutput(session);
      Object.assign(d, { output: out });
      const metrics = (await e.call("GET", `/sessions/${session.id}/metrics`, { session })).json;
      d.firstSegmentMs = metrics.processing.firstSegmentMs;
      d.speed = metrics.processing.speed;
      if (c.video) expect(out.videoCodec === c.video, `output video ${out.videoCodec}, expected ${c.video}`);
      if (c.audio) expect(out.audioCodec === c.audio, `output audio ${out.audioCodec}, expected ${c.audio}`);
      if (c.height) expect(out.height === c.height, `output height ${out.height}, expected ${c.height}`);
      if (c.pixFmt) expect(out.pixFmt === c.pixFmt, `pix_fmt ${out.pixFmt}`);
      if (c.transfer) expect(out.colorTransfer === c.transfer, `color_transfer ${out.colorTransfer}`);
    } finally {
      await closeSession(session);
    }
  });
}

await test(`9. Hardware encoder in use (${BACKEND}; NVIDIA: nvidia-smi engine utilization)`, async (d) => {
  const { session } = await create("hevc_ac3_long.mkv", CLIENTS.noHevc);
  try {
    const want = expectedPipeline("hevc");
    d.pipeline = session.decision.pipeline;
    expect(session.decision.pipeline === want, `pipeline ${session.decision.pipeline}, expected ${want}`);
    expect(session.decision.hardwareEncode === (BACKEND !== "software"), `hardwareEncode ${session.decision.hardwareEncode}`);
    let enc = 0, dec = 0, gpu = 0, samples = 0, speed = 0, gpuAvailable = false;
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const m = (await e.call("GET", `/sessions/${session.id}/metrics`, { session })).json;
      gpuAvailable ||= m.gpu.available === true;
      enc = Math.max(enc, m.gpu.encoderPercent ?? 0, m.gpu.peakEncoderPercentThisJob ?? 0);
      dec = Math.max(dec, m.gpu.decoderPercent ?? 0, m.gpu.peakDecoderPercentThisJob ?? 0);
      gpu = Math.max(gpu, m.gpu.utilizationPercent ?? 0);
      speed = Math.max(speed, m.processing.speed ?? 0);
      d.encoder = m.processing.encoder;
      samples++;
    }
    Object.assign(d, { peakEncoderPercent: enc, peakDecoderPercent: dec, peakGpuPercent: gpu, maxSpeed: speed, samples, gpuAvailable });
    expect(speed > 0, "transcode made no progress");
    if (BACKEND === "nvenc") {
      // nvidia-smi exposes the dedicated NVENC/NVDEC engines; other vendors have no equivalent counters.
      expect(gpuAvailable, "nvidia-smi sampling unavailable on an NVENC host");
      expect(enc > 0, "NVENC engine utilization stayed at 0%");
      if (want.startsWith("NVDEC")) expect(dec > 0, "NVDEC engine utilization stayed at 0%");
    } else if (BACKEND !== "software") {
      expect(d.encoder?.endsWith(`_${BACKEND}`), `encoder ${d.encoder} is not a ${BACKEND} encoder`);
    } else {
      expect(d.encoder === "libx264", `encoder ${d.encoder}`);
    }
  } finally {
    await closeSession(session);
  }
});

await test("10. Seek beyond encoded range restarts at the target (transcode)", async (d) => {
  const { session } = await create("hevc_ac3_long.mkv", CLIENTS.noHevc);
  try {
    const near = await e.call("POST", `/sessions/${session.id}/seek`, { session, body: { position: 3 } });
    expect(near.json.native === true, "seek inside the encoded window should be native");
    const far = await e.call("POST", `/sessions/${session.id}/seek`, { session, body: { position: 300 } });
    expect(far.status === 200, `seek ${far.status} ${JSON.stringify(far.json)}`);
    expect(far.json.native === false, "far seek should start a new generation");
    const s2 = far.json.session;
    d.generation = s2.generation;
    d.generationStart = s2.generationStart;
    expect(Math.abs(s2.generationStart - 300) < 0.6, `generation starts at ${s2.generationStart}, expected ≈300`);
    const out = await inspectHlsOutput({ ...session, ...s2, token: session.token });
    d.outputStart = out.startTime;
    expect(out.videoCodec === "h264", "output after seek is not h264");
  } finally {
    await closeSession(session);
  }
});

await test("10b. Seek with video copy lands on the preceding keyframe", async (d) => {
  const { session } = await create("hevc_ac3_long.mkv", CLIENTS.chromeWindows);
  try {
    expect(session.mode === "AudioTranscode", `mode ${session.mode}`);
    const far = await e.call("POST", `/sessions/${session.id}/seek`, { session, body: { position: 301 } });
    const s2 = far.json.session;
    d.generationStart = s2.generationStart;
    expect(s2.generationStart <= 301.05 && s2.generationStart >= 296, `copy seek started at ${s2.generationStart}`);
  } finally {
    await closeSession(session);
  }
});

await test("10c. Copy seek between keyframes keeps audio and video aligned", async (d) => {
  // Keyframes every 10 s; 205 s lands mid-GOP. Audio must start with the copied video keyframe,
  // otherwise MSE sees no playable range at the start of the new generation.
  const { session } = await create("h264_ac3_gop10_long.mkv", CLIENTS.chromeWindows);
  try {
    const far = await e.call("POST", `/sessions/${session.id}/seek`, { session, body: { position: 205 } });
    const s2 = far.json.session;
    d.generationStart = s2.generationStart;
    expect(Math.abs(s2.generationStart - 200) < 0.2, `copy seek started at ${s2.generationStart}, expected the 200 s keyframe`);
    const m = await e.call("GET", `/sessions/${session.id}/manifest`, { session });
    const lines = m.json.text.split("\n");
    const init = /URI="([^"]+)"/.exec(lines.find((l) => l.startsWith("#EXT-X-MAP")))[1];
    const seg = lines.find((l) => l && !l.startsWith("#"));
    const parts = [];
    for (const uri of [init, seg]) parts.push(Buffer.from(await (await e.call("GET", `/sessions/${session.id}/${uri}`, { session, raw: true })).arrayBuffer()));
    const file = path.join(tmpDir, `${session.id}-align.mp4`);
    fs.writeFileSync(file, Buffer.concat(parts));
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "packet=stream_index,pts_time", "-of", "csv=p=0", "-read_intervals", "%+#40", file], { encoding: "utf8" });
    const firstPts = {};
    for (const line of r.stdout.trim().split(/\r?\n/)) {
      const [idx, pts] = line.split(",");
      if (firstPts[idx] === undefined && pts !== "N/A") firstPts[idx] = Number(pts);
    }
    d.firstVideoPts = firstPts["0"];
    d.firstAudioPts = firstPts["1"];
    expect(d.firstVideoPts != null && d.firstAudioPts != null, `missing tracks in output: ${JSON.stringify(firstPts)}`);
    expect(Math.abs(d.firstAudioPts - d.firstVideoPts) < 0.25, `audio starts ${(d.firstAudioPts - d.firstVideoPts).toFixed(2)} s after video`);
  } finally {
    await closeSession(session);
  }
});

await test("10d. Audio language: English preferred picks the English track, not the first (Russian) one", async (d) => {
  const { session } = await create("h264_eng_rus.mkv", CLIENTS.chromeWindows, { preferences: { audioLanguages: ["en"] } });
  try {
    d.tracks = session.tracks.audio.map((a) => `${a.index}:${a.languageCode ?? "unknown"}`);
    d.selected = session.tracks.selectedAudio;
    d.selectedLanguage = session.tracks.selectedAudioLanguage;
    d.matched = session.tracks.audioLanguageMatched;
    expect(session.tracks.audio[0].languageCode === "ru", "first track should be Russian in the fixture");
    expect(session.tracks.selectedAudio === 2, `selected track ${session.tracks.selectedAudio}, expected 2 (English)`);
    expect(session.tracks.audioLanguageMatched === true, "audioLanguageMatched should be true");
    expect(session.tracks.audio[2].languageCode === null, "untagged track must report unknown, not English");
    const out = await inspectHlsOutput(session, 1);
    expect(out.audioCodec === "aac", `output audio ${out.audioCodec}`);
  } finally {
    await closeSession(session);
  }
});

await test("10e. Audio language: Russian preferred picks the 5.1 Russian track; missing language reports mismatch", async (d) => {
  const ru = await create("h264_eng_rus.mkv", CLIENTS.chromeWindows, { preferences: { audioLanguages: ["ru"] } });
  try {
    d.ruSelected = ru.session.tracks.selectedAudio;
    expect(ru.session.tracks.selectedAudio === 1, `ru selected ${ru.session.tracks.selectedAudio}`);
  } finally {
    await closeSession(ru.session);
  }
  const de = await create("h264_eng_rus.mkv", CLIENTS.chromeWindows, { preferences: { audioLanguages: ["de", "fr"] } });
  try {
    d.deSelected = de.session.tracks.selectedAudio;
    d.deMatched = de.session.tracks.audioLanguageMatched;
    expect(de.session.tracks.audioLanguageMatched === false, "German/French preference must be reported as unmatched");
    expect(de.session.tracks.availableAudioLanguages.join(",") === "ru,en", `available ${de.session.tracks.availableAudioLanguages}`);
  } finally {
    await closeSession(de.session);
  }
});

await test("10f. Switching audio mid-playback keeps the position and only re-encodes audio", async (d) => {
  const { session } = await create("h264_eng_rus.mkv", CLIENTS.chromeWindows, { preferences: { audioLanguages: ["en"] } });
  try {
    expect(session.mode === "Remux" || session.mode === "AudioTranscode", `initial mode ${session.mode}`);
    const r = await e.call("POST", `/sessions/${session.id}/tracks`, { session, body: { audioIndex: 1, position: 95 } });
    expect(r.status === 200, `tracks ${r.status} ${JSON.stringify(r.json)}`);
    d.mode = r.json.mode;
    d.generationStart = r.json.generationStart;
    d.selected = r.json.tracks.selectedAudio;
    expect(r.json.tracks.selectedAudio === 1, "Russian track not selected");
    expect(r.json.decision.video === "Copy", `video must stay copied (${r.json.decision.video})`);
    expect(Math.abs(r.json.generationStart - 95) < 2.5, `restarted at ${r.json.generationStart}, expected ≈95 (keyframe before)`);
    const out = await inspectHlsOutput({ ...session, ...r.json, token: session.token }, 1);
    expect(out.videoCodec === "h264" && out.audioCodec === "aac", `output ${out.videoCodec}/${out.audioCodec}`);
  } finally {
    await closeSession(session);
  }
});

await test("10g. Probe-only endpoint reports verified languages without starting a stream", async (d) => {
  const { mintTicket } = await import("./lib/engine-client.mjs");
  const before = (await e.call("GET", "/capabilities")).json.load.activeJobs;
  const r = await e.call("POST", "/probe", { body: { ticket: mintTicket(SECRET, { kind: "file", path: media("h264_eng_rus.mkv"), provider: "sample" }, "o") } });
  expect(r.status === 200, `probe ${r.status} ${JSON.stringify(r.json)}`);
  d.audioLanguages = r.json.source.audioLanguages;
  d.subtitleLanguages = r.json.source.subtitleLanguages;
  d.untagged = r.json.source.untaggedAudioTracks;
  d.probeMs = r.json.probeMs;
  expect(r.json.source.audioLanguages.join(",") === "ru,en", "audio languages");
  expect(r.json.source.subtitleLanguages.join(",") === "en,ru", "subtitle languages");
  expect(r.json.source.untaggedAudioTracks === 1, "one untagged track");
  // Second probe of the same file is served from the engine's cache.
  const again = await e.call("POST", "/probe", { body: { ticket: mintTicket(SECRET, { kind: "file", path: media("h264_eng_rus.mkv"), provider: "sample" }, "o") } });
  d.cachedProbeMs = again.json.probeMs;
  expect(again.json.probeMs <= 50, `cached probe took ${again.json.probeMs} ms`);
  const after = (await e.call("GET", "/capabilities")).json.load.activeJobs;
  expect(after === before, "probe must not leave a job running");
});

await test("10h. Russian embedded SRT extracts to WebVTT with UTF-8 text", async (d) => {
  const { session } = await create("h264_eng_rus.mkv", CLIENTS.chromeWindows);
  try {
    const rus = session.tracks.subtitles.find((s) => s.languageCode === "ru");
    expect(rus, "no Russian subtitle track");
    let text = "", complete = false;
    for (let i = 0; i < 20 && !complete; i++) {
      const r = await e.call("GET", `/sessions/${session.id}/subtitles/${rus.index}?from=0`, { session, raw: true });
      text = await r.text();
      complete = r.headers.get("x-subtitle-complete") === "1";
      if (!complete) await sleep(300);
    }
    d.cues = (text.match(/-->/g) || []).length;
    expect(text.includes("Русская строка 1"), "Cyrillic text not preserved");
    expect(d.cues >= 100, `only ${d.cues} cues`);
  } finally {
    await closeSession(session);
  }
});

await test("11. Pause → encoder throttles ahead of the viewer, resumes on demand", async (d) => {
  const { session } = await create("hevc_ac3_long.mkv", CLIENTS.chromeWindows);
  try {
    let status;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      status = (await e.call("GET", `/sessions/${session.id}/status?position=0`, { session })).json;
      if (status.state === "Throttled") break;
    }
    d.producedWhenThrottled = status.producedUntil;
    expect(status.state === "Throttled", `state ${status.state}, produced ${status.producedUntil}`);
    // Viewer "resumes" and moves forward: encoder must continue.
    const res = await e.call("GET", `/sessions/${session.id}/status?position=200`, { session });
    await sleep(1500);
    const after = (await e.call("GET", `/sessions/${session.id}/status?position=200`, { session })).json;
    d.stateAfterResume = after.state;
    d.producedAfterResume = after.producedUntil;
    expect(res.status === 200 && (after.producedUntil > status.producedUntil || after.ended), "encoder did not resume");
  } finally {
    await closeSession(session);
  }
});

await test("12. Cancellation during transcode kills FFmpeg and removes temp files", async (d) => {
  const { session } = await create("hevc_ac3_long.mkv", CLIENTS.noHevc);
  await sleep(1500);
  const pid = (await e.call("GET", `/sessions/${session.id}/metrics`, { session })).json.processing.processId;
  d.ffmpegPid = pid;
  const before = processAlive(pid);
  d.ffmpegBefore = before ? 1 : 0;
  expect(before, "ffmpeg process for the session is not running");
  const del = await e.call("DELETE", `/sessions/${session.id}`, { session });
  expect(del.status === 204, `delete ${del.status}`);
  await sleep(800);
  d.ffmpegAfter = processAlive(pid) ? 1 : 0;
  const dir = path.join(CAPS?.cache?.engineDirectory ?? path.join(os.tmpdir(), "notflix-media-engine"), session.id);
  d.tempDirExists = fs.existsSync(dir);
  expect(d.ffmpegAfter === 0, "ffmpeg still running after cancel");
  expect(!d.tempDirExists, "temp directory not removed");
  const gone = await e.call("GET", `/sessions/${session.id}/status`, { session });
  expect(gone.status === 404, "session should be gone");
});

await test("13. Audio track switch (AAC → AC-3) re-plans as audio transcode", async (d) => {
  const { session } = await create("h264_multiaudio.mkv", CLIENTS.chromeWindows);
  try {
    d.initialMode = session.mode;
    expect(session.mode === "Remux", `initial ${session.mode}`);
    const ac3 = session.tracks.audio.find((a) => a.codec === "ac3");
    const r = await e.call("POST", `/sessions/${session.id}/tracks`, { session, body: { audioIndex: ac3.index, position: 5 } });
    expect(r.status === 200, `tracks ${r.status}`);
    d.newMode = r.json.mode;
    d.generation = r.json.generation;
    expect(r.json.mode === "AudioTranscode", `after switch ${r.json.mode}`);
    const out = await inspectHlsOutput({ ...session, ...r.json, token: session.token }, 1);
    expect(out.audioCodec === "aac" && out.videoCodec === "h264", `output ${out.videoCodec}/${out.audioCodec}`);
  } finally {
    await closeSession(session);
  }
});

await test("14. Embedded text subtitles extracted to WebVTT", async (d) => {
  const { session } = await create("h264_multiaudio.mkv", CLIENTS.chromeWindows);
  try {
    const sub = session.tracks.subtitles[0];
    expect(sub?.kind === "text", "no text subtitle track");
    let text = "", complete = false;
    for (let i = 0; i < 20 && !complete; i++) {
      const r = await e.call("GET", `/sessions/${session.id}/subtitles/${sub.index}?from=0`, { session, raw: true });
      text = await r.text();
      complete = r.headers.get("x-subtitle-complete") === "1";
      if (!complete) await sleep(300);
    }
    d.cues = (text.match(/-->/g) || []).length;
    expect(text.startsWith("WEBVTT") && text.includes("Subtitle line 1"), "VTT content missing");
    expect(d.cues >= 9, `only ${d.cues} cues`);
  } finally {
    await closeSession(session);
  }
});

await test("15. Security: forged/expired/replayed tickets and disallowed sources rejected", async (d) => {
  const good = { kind: "file", path: media("h264_aac.mp4"), provider: "sample" };
  const forged = await e.call("POST", "/sessions", { body: { ticket: "eyJ2IjoxfQ.AAAA" } });
  const { mintTicket } = await import("./lib/engine-client.mjs");
  const expired = await e.call("POST", "/sessions", { body: { ticket: mintTicket(SECRET, good, "o", -5) } });
  const t = mintTicket(SECRET, good, "o");
  const first = await e.call("POST", "/sessions", { body: { ticket: t } });
  const replay = await e.call("POST", "/sessions", { body: { ticket: t } });
  const outside = await e.call("POST", "/sessions", { body: { ticket: mintTicket(SECRET, { kind: "file", path: "C:\\Windows\\win.ini" }, "o") } });
  const ssrf = await e.call("POST", "/sessions", { body: { ticket: mintTicket(SECRET, { kind: "url", url: "http://169.254.169.254/latest/meta-data" }, "o") } });
  const evil = await e.call("POST", "/sessions", { body: { ticket: mintTicket(SECRET, { kind: "url", url: "https://real-debrid.com.evil.example/x.mkv" }, "o") } });
  Object.assign(d, { forged: forged.status, expired: expired.status, first: first.status, replay: replay.status, outside: outside.status, ssrf: ssrf.status, evilSuffix: evil.status });
  if (first.status === 201) {
    const s = first.json;
    const wrongOwner = await fetch(`${ENGINE_URL}/sessions/${s.id}`, { headers: { "X-Engine-Key": SECRET, "X-Session-Token": s.token, "X-Owner": "someone-else" } });
    d.wrongOwner = wrongOwner.status;
    const wrongToken = await fetch(`${ENGINE_URL}/sessions/${s.id}`, { headers: { "X-Engine-Key": SECRET, "X-Session-Token": "nope", "X-Owner": "o" } });
    d.wrongToken = wrongToken.status;
    await fetch(`${ENGINE_URL}/sessions/${s.id}`, { method: "DELETE", headers: { "X-Engine-Key": SECRET, "X-Session-Token": s.token, "X-Owner": "o" } });
  }
  expect(forged.status === 403 && expired.status === 403 && replay.status === 403, "ticket checks failed");
  expect(first.status === 201, "valid ticket rejected");
  expect(outside.status === 403 && ssrf.status === 403 && evil.status === 403, "source guard failed");
  expect(d.wrongOwner === 404 && d.wrongToken === 404, "session token/owner checks failed");
});

await test("17. AMF run: hardwareAcceleration=amf via /config → valid AMF H.264 output", async (d) => {
  const amf = backendReport("amf");
  d.amfStatus = amf?.status;
  if (amf?.status !== "verified" || amf?.encoders?.h264 !== "verified") skip(`AMF not verified on this host (${amf?.status ?? "not reported"})`);
  const before = (await e.call("GET", "/capabilities")).json.limits.hardwareAcceleration;
  const set = await e.call("POST", "/config", { body: { hardwareAcceleration: "amf" } });
  try {
    expect(set.status === 200, `config ${set.status} ${JSON.stringify(set.json)}`);
    d.selection = set.json.selection;
    expect(set.json.selection?.effective === "amf", `selection ${JSON.stringify(set.json.selection)}`);
    for (const [file, codec] of [["mpeg2_mp2.ts", "mpeg2video"], ["hevc_ac3.mkv", "hevc"]]) {
      const { session } = await create(file, CLIENTS.h264Only);
      try {
        const pipeline = session.decision.pipeline;
        d[`${codec}Pipeline`] = pipeline;
        expect(/AMF H\.264$/.test(pipeline ?? ""), `pipeline ${pipeline} does not use AMF`);
        if (CAPS?.platform?.os === "windows") {
          const want = amf.decoders?.[codec] === "verified" ? "D3D11VA + AMF H.264" : "CPU decode + AMF H.264";
          expect(pipeline === want, `pipeline ${pipeline}, expected ${want}`);
        }
        expect(session.decision.hardwareEncode === true, "hardwareEncode should be true for AMF");
        const out = await inspectHlsOutput(session, 2);
        d[`${codec}Output`] = `${out.videoCodec}/${out.audioCodec} ${out.width}x${out.height} ${out.pixFmt} ${out.bytes} B`;
        expect(out.videoCodec === "h264", `output video ${out.videoCodec}`);
        expect(out.bytes > 10_000 && out.playlistSegments >= 2, `output too small (${out.bytes} bytes, ${out.playlistSegments} segments)`);
        const metrics = (await e.call("GET", `/sessions/${session.id}/metrics`, { session })).json;
        d[`${codec}Encoder`] = metrics.processing.encoder;
        expect(metrics.processing.encoder === "h264_amf", `encoder ${metrics.processing.encoder}`);
      } finally {
        await closeSession(session);
      }
    }
  } finally {
    await e.call("POST", "/config", { body: { hardwareAcceleration: before } });
  }
});

// --- Network tests use a second engine instance that allowlists 127.0.0.1 and a local flaky server.
await test("16. Network interruption mid-stream: FFmpeg reconnects and continues", async (d) => {
  const file = media("hevc_ac3_long.mkv");
  const size = fs.statSync(file).size;
  let drops = 0, requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url.startsWith("/expired")) {
      res.writeHead(404).end("gone");
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, {
      "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = fs.createReadStream(file, { start, end });
    let sent = 0;
    stream.on("data", (chunk) => {
      sent += chunk.length;
      // Drop the connection once, ~25 MB into the file, to simulate a network blip.
      if (drops === 0 && start + sent > 25_000_000) {
        drops++;
        stream.destroy();
        req.socket.destroy();
      }
    });
    stream.pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const engine2 = await startSecondEngine();
  try {
    const e2 = engine({ url: engine2.url, secret: SECRET });
    const r = await e2.createSession({ kind: "url", url: `http://127.0.0.1:${port}/long.mkv`, provider: "test-http" }, { client: CLIENTS.chromeWindows });
    expect(r.status === 201, `create ${r.status} ${JSON.stringify(r.json)}`);
    const s = r.json;
    let status;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      status = (await e2.call("GET", `/sessions/${s.id}/status?position=0`, { session: s })).json;
      if (status.producedUntil > 200 || status.ended || status.state === "Throttled") break;
    }
    Object.assign(d, { drops, requests, producedUntil: status.producedUntil, state: status.state, restarts: status.restarts });
    expect(drops === 1, "connection was never dropped");
    expect(requests >= 2, "ffmpeg did not reconnect");
    expect(status.producedUntil > 120, `only produced ${status.producedUntil}s after the drop`);
    await e2.call("DELETE", `/sessions/${s.id}`, { session: s });

    const expired = await e2.createSession({ kind: "url", url: `http://127.0.0.1:${port}/expired.mkv`, provider: "test-http" }, { client: CLIENTS.chromeWindows });
    d.expiredStatus = expired.status;
    d.expiredCode = expired.json?.code;
    expect(expired.status === 410, `expired link → ${expired.status} ${JSON.stringify(expired.json)}`);
  } finally {
    server.close();
    await engine2.stop();
  }
});

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startSecondEngine() {
  const port = Number(process.env.SECOND_ENGINE_PORT || 8522);
  const dll = process.env.ENGINE_DLL ||
    path.join(repoRoot, "services", "media-engine", "src", "Notflix.MediaEngine", "bin", "Debug", "net10.0", "Notflix.MediaEngine.dll");
  // A throwaway data dir: the engine reads its secret and settings from there (no repository .env).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-engine2-"));
  fs.mkdirSync(path.join(dataDir, "secrets"));
  fs.mkdirSync(path.join(dataDir, "config"));
  fs.writeFileSync(path.join(dataDir, "secrets", "engine-secret"), SECRET + "\n");
  fs.writeFileSync(path.join(dataDir, "config", "engine.json"), JSON.stringify({
    port, cacheDirectory: path.join(dataDir, "cache"), allowedPrivateHosts: ["127.0.0.1"],
  }, null, 2));
  const childEnv = { ...process.env, NOTFLIX_DATA_DIR: dataDir, Logging__LogLevel__Default: "Warning" };
  for (const k of ["MEDIA_ENGINE_SECRET", "MEDIA_ENGINE_PORT", "MEDIA_ENGINE_TEMP_DIR", "MEDIA_ENGINE_BIND"]) delete childEnv[k];
  const child = spawn("dotnet", [dll], { env: childEnv, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch { /* starting */ }
    await sleep(250);
  }
  // Wait for hardware detection so the first session is not slowed by it.
  await fetch(`${url}/capabilities`, { headers: { "X-Engine-Key": SECRET } }).catch(() => undefined);
  return {
    url,
    stop: async () => {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      await sleep(300);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

if (HWACCEL && previousHwaccel) await e.call("POST", "/config", { body: { hardwareAcceleration: previousHwaccel } });
fs.rmSync(tmpDir, { recursive: true, force: true });
const outDir = env.MATRIX_OUT_DIR || path.join(repoRoot, "test-results");
const outName = `media-engine-matrix${HWACCEL ? `-${HWACCEL}` : ""}`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${outName}.json`), JSON.stringify({
  at: new Date().toISOString(), engine: ENGINE_URL, requested: HWACCEL ?? "engine default", backend: BACKEND,
  selection: CAPS?.selection, results,
}, null, 2));
const md = [
  "| Result | Test | Time | Details |",
  "|---|---|---:|---|",
  ...results.map((r) => `| ${r.skipped ? "SKIP" : r.ok ? "PASS" : "**FAIL**"} | ${r.name} | ${r.ms} ms | ${(r.error ?? r.skipped ?? summarize(r.details)).replace(/\|/g, "/")} |`),
].join("\n");
fs.writeFileSync(path.join(outDir, `${outName}.md`), `Backend: ${BACKEND} (requested ${HWACCEL ?? "engine default"})\n\n${md}\n`);
const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed - skipped}/${results.length} passed, ${skipped} skipped (backend ${BACKEND}). Results: ${path.join(outDir, outName)}.md`);
process.exit(failed ? 1 : 0);

function summarize(d) {
  const parts = [];
  if (d.mode) parts.push(d.mode);
  if (d.pipeline) parts.push(d.pipeline);
  if (d.output) parts.push(`${d.output.videoCodec}/${d.output.audioCodec} ${d.output.width}x${d.output.height}${d.output.colorTransfer ? " " + d.output.colorTransfer : ""}`);
  if (d.createMs != null) parts.push(`ready ${d.createMs} ms`);
  if (d.firstSegmentMs != null) parts.push(`1st seg ${d.firstSegmentMs} ms`);
  if (d.speed) parts.push(`${d.speed}x`);
  if (d.encoder) parts.push(d.encoder);
  for (const k of ["peakEncoderPercent", "peakDecoderPercent", "maxSpeed", "generationStart", "producedWhenThrottled", "ffmpegBefore", "ffmpegAfter", "cues", "drops", "requests", "producedUntil", "expiredStatus", "contentRange"])
    if (d[k] != null) parts.push(`${k}=${d[k]}`);
  return parts.join(", ").replace(/\|/g, "/");
}
