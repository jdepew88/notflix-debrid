#!/usr/bin/env node
/**
 * Generates deterministic, authorized sample files covering the playback codec matrix.
 * Output: <repo>/test-media (git-ignored). Re-running skips files that already exist.
 *
 *   node scripts/generate-test-media.mjs [--force]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "test-media");
const force = process.argv.includes("--force");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
fs.mkdirSync(out, { recursive: true });

// 20 s of moving test pattern + tone; long sample for seek tests.
const video = (size, seconds, rate = 24) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
const tone = (seconds, layout = "stereo") => [
  "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
  "-filter:a", `aformat=channel_layouts=${layout}`,
];

const samples = [
  { name: "h264_aac.mp4", note: "H.264 + AAC in MP4 (direct play)",
    args: [...video("1920x1080", 20), ...tone(20), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"] },
  { name: "h264_aac.mkv", note: "H.264 + AAC in MKV (remux)",
    args: [...video("1920x1080", 20), ...tone(20), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "aac", "-b:a", "160k"] },
  { name: "h264_dts.mkv", note: "H.264 + DTS 5.1 in MKV (audio transcode)",
    args: [...video("1920x1080", 20), ...tone(20, "5.1"), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "dca", "-strict", "-2", "-b:a", "768k"] },
  { name: "hevc_ac3.mkv", note: "HEVC 8-bit + AC-3 5.1 in MKV",
    args: [...video("1920x1080", 20), ...tone(20, "5.1"), "-c:v", "hevc_nvenc", "-preset", "p4", "-g", "48",
      "-c:a", "ac3", "-b:a", "448k"] },
  { name: "hevc10_truehd.mkv", note: "HEVC Main10 + TrueHD in MKV",
    args: [...video("1920x1080", 20), ...tone(20, "5.1"), "-pix_fmt", "p010le", "-c:v", "hevc_nvenc", "-profile:v", "main10", "-preset", "p4", "-g", "48",
      "-c:a", "truehd", "-strict", "-2"] },
  { name: "hevc10_hdr10_2160p.mkv", note: "4K HEVC Main10 HDR10 (PQ/BT.2020) + E-AC-3",
    args: [...video("3840x2160", 12), ...tone(12, "5.1"), "-pix_fmt", "p010le", "-c:v", "hevc_nvenc", "-profile:v", "main10", "-preset", "p4", "-g", "48",
      // NVENC ignores -color_* flags; write the HDR10 VUI (BT.2020 / PQ) into the bitstream directly.
      "-bsf:v", "hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9",
      "-c:a", "eac3", "-b:a", "640k"] },
  { name: "av1_opus.webm", note: "AV1 + Opus in WebM",
    args: [...video("1920x1080", 20), ...tone(20), "-c:v", "av1_nvenc", "-preset", "p4", "-g", "48", "-c:a", "libopus", "-b:a", "128k"] },
  { name: "av1_aac.mp4", note: "AV1 + AAC in MP4",
    args: [...video("1920x1080", 20), ...tone(20), "-c:v", "av1_nvenc", "-preset", "p4", "-g", "48", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"] },
  { name: "vp9_opus.webm", note: "VP9 + Opus in WebM",
    args: [...video("1280x720", 12), ...tone(12), "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M", "-c:a", "libopus"] },
  { name: "mpeg2_mp2.ts", note: "MPEG-2 + MP2 in MPEG-TS (video transcode)",
    args: [...video("1280x720", 20, 25), ...tone(20), "-c:v", "mpeg2video", "-b:v", "6M", "-c:a", "mp2", "-b:a", "192k"] },
  { name: "mpeg4_mp3.avi", note: "MPEG-4 Part 2 + MP3 in AVI (video transcode)",
    args: [...video("1280x720", 20, 25), ...tone(20), "-c:v", "mpeg4", "-vtag", "XVID", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k"] },
  { name: "h264_hi10_aac.mkv", note: "H.264 High10 (not browser-decodable) + AAC",
    args: [...video("1280x720", 12), ...tone(12), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p10le", "-c:a", "aac"] },
  { name: "h264_multiaudio.mkv", note: "H.264 + AAC (eng) + AC-3 (spa) + SRT subtitles",
    pre: () => writeSrt("multi.srt", 20),
    args: [...video("1280x720", 20), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=20", "-i", path.join(out, "multi.srt"),
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a:0", "aac", "-c:a:1", "ac3", "-c:s", "srt",
      "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English Stereo",
      "-metadata:s:a:1", "language=spa", "-metadata:s:a:1", "title=Spanish",
      "-metadata:s:s:0", "language=eng"] },
  { name: "h264_eng_rus.mkv", note: "4-minute H.264 + Russian AC-3 5.1 (first/default) + English AAC + untagged AAC, SRT subs eng/rus",
    pre: () => { writeSrt("eng.srt", 240, "English line"); writeSrt("rus.srt", 240, "Русская строка"); },
    args: [...video("1280x720", 240), "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=240",
      "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=240", "-f", "lavfi", "-i", "sine=frequency=990:sample_rate=48000:duration=240",
      "-i", path.join(out, "eng.srt"), "-i", path.join(out, "rus.srt"),
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a", "-map", "4:s", "-map", "5:s",
      "-c:v", "h264_nvenc", "-preset", "p1", "-g", "48",
      "-filter:a:0", "aformat=channel_layouts=5.1", "-c:a:0", "ac3", "-b:a:0", "384k", "-c:a:1", "aac", "-c:a:2", "aac", "-c:s", "srt",
      "-metadata:s:a:0", "language=rus", "-metadata:s:a:0", "title=Russian 5.1", "-disposition:a:0", "default",
      "-metadata:s:a:1", "language=eng", "-metadata:s:a:1", "title=English Stereo", "-disposition:a:1", "0",
      "-metadata:s:a:2", "title=Unknown track",
      "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=rus"] },
  { name: "hevc_ac3_long.mkv", note: "6-minute HEVC + AC-3 for seek / buffering tests",
    args: [...video("1920x1080", 360), ...tone(360, "5.1"), "-c:v", "hevc_nvenc", "-preset", "p1", "-g", "96",
      "-c:a", "ac3", "-b:a", "384k"] },
  { name: "h264_ac3_gop10_long.mkv", note: "4-minute H.264 + AC-3, 10 s keyframe interval (real-world copy-seek alignment)",
    args: [...video("1920x1080", 240), ...tone(240, "5.1"), "-c:v", "h264_nvenc", "-preset", "p1", "-g", "240", "-forced-idr", "1",
      "-c:a", "ac3", "-b:a", "384k"] },
  { name: "hevc10_opengop_long.mkv", note: "3-minute x265 Main10 open-GOP (CRA + RASL leading frames) + PCM, like real encodes",
    args: [...video("1280x720", 180), ...tone(180), "-pix_fmt", "yuv420p10le", "-c:v", "libx265", "-preset", "superfast",
      "-x265-params", "keyint=240:min-keyint=240:open-gop=1:bframes=4:log-level=error", "-c:a", "pcm_s24le"] },
  { name: "h264_aac_long.mp4", note: "6-minute H.264 + AAC MP4 for direct-play seek tests",
    args: [...video("1920x1080", 360), ...tone(360), "-c:v", "h264_nvenc", "-preset", "p1", "-g", "96",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"] },
];

function writeSrt(name, seconds, text = "Subtitle line") {
  const lines = [];
  const t = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")},${String(Math.round((sec % 1) * 1000)).padStart(3, "0")}`;
  };
  for (let i = 0; i < seconds / 2; i++) {
    lines.push(String(i + 1), `${t(i * 2)} --> ${t(i * 2 + 1.8)}`, `${text} ${i + 1}`, "");
  }
  fs.writeFileSync(path.join(out, name), lines.join("\n"));
}

// External sidecar subtitle used by the "external subtitles" test.
writeSrt("h264_aac.en.srt", 20);

// Some samples are encoded with NVENC because it is fast. On machines without a working NVENC encoder
// the same sample is produced with the equivalent CPU encoder instead (slower, same codec/profile).
const encoderWorks = new Map();
function canEncode(encoder) {
  if (!encoderWorks.has(encoder)) {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-frames:v", "5",
      "-c:v", encoder, "-f", "null", "-"], { encoding: "utf8" });
    encoderWorks.set(encoder, r.status === 0);
  }
  return encoderWorks.get(encoder);
}
const CPU_FALLBACK = { h264_nvenc: "libx264", hevc_nvenc: "libx265", av1_nvenc: "libsvtav1" };
function portable(args) {
  const i = args.indexOf("-c:v");
  const enc = i >= 0 ? args[i + 1] : null;
  if (!enc || !CPU_FALLBACK[enc] || canEncode(enc)) return args;
  const cpu = CPU_FALLBACK[enc];
  const outArgs = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (k === i + 1) outArgs.push(cpu);
    else if (a === "-preset") outArgs.push(a, cpu === "libsvtav1" ? "10" : "veryfast"), k++;
    else if (a === "-forced-idr") k++; // NVENC-only option
    else if (a === "-pix_fmt" && args[k + 1] === "p010le") outArgs.push(a, "yuv420p10le"), k++;
    else if (a === "-profile:v" && cpu === "libsvtav1") k++;
    else outArgs.push(a);
  }
  if (cpu === "libx265") outArgs.push("-x265-params", "log-level=error");
  return outArgs;
}

let failed = 0;
for (const s of samples) {
  const file = path.join(out, s.name);
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) {
    console.log(`skip  ${s.name}`);
    continue;
  }
  s.pre?.();
  const started = Date.now();
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...portable(s.args), file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL  ${s.name}: ${r.stderr?.trim().split("\n").slice(-3).join(" | ")}`);
    continue;
  }
  console.log(`ok    ${s.name.padEnd(26)} ${(fs.statSync(file).size / 1e6).toFixed(1).padStart(6)} MB  ${((Date.now() - started) / 1000).toFixed(1)}s  ${s.note}`);
}
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(samples.map(({ name, note }) => ({ name, note })), null, 2));
process.exit(failed ? 1 : 0);
