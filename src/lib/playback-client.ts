"use client";

/**
 * Browser side of the playback pipeline: what this browser can decode (reported to the media
 * engine so it can pick Direct Play / Remux / Audio / Video transcode), plus small helpers used by
 * the player for engine sessions.
 */

export interface ClientCapabilities {
  directVideo: string[];
  directAudio: string[];
  mseVideo: string[];
  mseAudio: string[];
  tenBit: string[];
  hdrDisplay: boolean;
  mse: boolean;
  nativeHls: boolean;
}

/** Representative codec strings (profile/level high enough for 4K content where relevant). */
const VIDEO_PROBES: Record<string, { mp4: string; tenBit?: string; webm?: string }> = {
  h264: { mp4: 'video/mp4; codecs="avc1.640033"' },
  hevc: { mp4: 'video/mp4; codecs="hvc1.1.6.L153.B0"', tenBit: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
  av1: { mp4: 'video/mp4; codecs="av01.0.12M.08"', tenBit: 'video/mp4; codecs="av01.0.12M.10"', webm: 'video/webm; codecs="av01.0.12M.08"' },
  vp9: { mp4: 'video/mp4; codecs="vp09.00.51.08"', tenBit: 'video/mp4; codecs="vp09.02.51.10"', webm: 'video/webm; codecs="vp9"' },
  vp8: { mp4: "", webm: 'video/webm; codecs="vp8"' },
};

const AUDIO_PROBES: Record<string, { mp4?: string; other?: string }> = {
  aac: { mp4: 'audio/mp4; codecs="mp4a.40.2"' },
  mp3: { mp4: 'audio/mp4; codecs="mp4a.6B"', other: "audio/mpeg" },
  opus: { mp4: 'audio/mp4; codecs="opus"', other: 'audio/webm; codecs="opus"' },
  flac: { mp4: 'audio/mp4; codecs="flac"' },
  vorbis: { other: 'audio/webm; codecs="vorbis"' },
  ac3: { mp4: 'audio/mp4; codecs="ac-3"' },
  eac3: { mp4: 'audio/mp4; codecs="ec-3"' },
};

let cached: ClientCapabilities | null = null;

export function detectClientCapabilities(): ClientCapabilities {
  if (cached) return cached;
  if (typeof window === "undefined") {
    return { directVideo: ["h264"], directAudio: ["aac"], mseVideo: ["h264"], mseAudio: ["aac"], tenBit: [], hdrDisplay: false, mse: true, nativeHls: false };
  }
  const video = document.createElement("video");
  const MS: { isTypeSupported(t: string): boolean } | undefined =
    (window as unknown as { ManagedMediaSource?: { isTypeSupported(t: string): boolean } }).ManagedMediaSource ??
    (typeof MediaSource !== "undefined" ? MediaSource : undefined);
  const mse = (type: string) => Boolean(type && MS?.isTypeSupported(type));
  const direct = (type: string) => Boolean(type && video.canPlayType(type) !== "");

  const caps: ClientCapabilities = {
    directVideo: [],
    directAudio: [],
    mseVideo: [],
    mseAudio: [],
    tenBit: [],
    hdrDisplay: window.matchMedia?.("(dynamic-range: high)").matches ?? false,
    mse: Boolean(MS),
    nativeHls: direct("application/vnd.apple.mpegurl"),
  };
  for (const [codec, p] of Object.entries(VIDEO_PROBES)) {
    if (direct(p.mp4) || (p.webm && direct(p.webm))) caps.directVideo.push(codec);
    if (mse(p.mp4)) caps.mseVideo.push(codec);
    if (p.tenBit && (mse(p.tenBit) || direct(p.tenBit))) caps.tenBit.push(codec);
  }
  for (const [codec, p] of Object.entries(AUDIO_PROBES)) {
    if ((p.mp4 && direct(p.mp4)) || (p.other && direct(p.other))) caps.directAudio.push(codec);
    if (p.mp4 && mse(p.mp4)) caps.mseAudio.push(codec);
  }
  // Safari without MSE (iPhone) plays HLS natively; its HLS decoder set equals its direct set.
  if (!caps.mse && caps.nativeHls) {
    caps.mseVideo = [...caps.directVideo];
    caps.mseAudio = [...caps.directAudio];
  }
  cached = caps;
  return caps;
}

export interface EngineTrack {
  index: number;
  codec: string;
  language?: string;
  /** Normalised two-letter code; null when the track is untagged. */
  languageCode?: string | null;
  title?: string;
  channels?: number;
  default?: boolean;
  forced?: boolean;
  kind?: string;
}

export interface EngineSessionView {
  id: string;
  mode: "DirectPlay" | "Remux" | "AudioTranscode" | "VideoTranscode";
  modeLabel: string;
  output: "hls" | "progressive";
  generation: number;
  generationStart: number;
  durationSeconds: number | null;
  sourceStartTime: number;
  startupMs: number | null;
  probeMs: number;
  state: string;
  decision: {
    video: string;
    audio: string;
    outputVideoCodec: string;
    outputAudioCodec: string;
    width: number;
    height: number;
    targetVideoKbps: number | null;
    pipeline: string | null;
    hardwareDecode: boolean | null;
    hardwareEncode: boolean | null;
    tonemap: string | null;
    reasons: string[];
  };
  tracks: {
    audio: EngineTrack[];
    subtitles: EngineTrack[];
    selectedAudio: number | null;
    selectedSubtitle: number | null;
    selectedAudioLanguage?: string | null;
    audioLanguageMatched?: boolean | null;
    availableAudioLanguages?: string[];
  };
  source: Record<string, unknown> & {
    provider?: string;
    fileName?: string;
    fileSize?: number;
    container?: string;
    video?: Record<string, unknown> & { codec?: string; width?: number; height?: number; dynamicRange?: string; frameRate?: number };
  };
}

export interface EngineStatus {
  id: string;
  mode: string;
  generation: number;
  generationStart: number;
  state: string;
  producedUntil: number | null;
  evictedUntil: number | null;
  ended: boolean;
  speed: number | null;
  error: string | null;
  restarts: number;
}

export interface StartPlaybackResponse {
  ok: boolean;
  engine?: "online" | "offline";
  session?: EngineSessionView;
  urls?: { manifest?: string; stream?: string; cast?: string };
  fallback?: { kind: "direct"; url: string; reason: string };
  item?: import("./types").MediaItem;
  watchId?: string;
  provider?: string;
  streamLabel?: string;
  quality?: string;
  candidateIndex?: number;
  sourceHash?: string;
  candidates?: number;
  alternativesWithLanguage?: number;
  candidatesTried?: number;
  defaultSubtitleIndex?: number | null;
  audio?: { selectedLanguage: string | null; matched: boolean | null; available: string[]; preferred: string[] };
  timing?: { resolveMs: number; linkMs: number; engineMs: number; totalMs: number; probeMs?: number };
  notices?: string[];
  error?: string;
  code?: string;
  details?: string[];
}

export function sessionPlaybackUrl(session: EngineSessionView): string {
  const base = `/api/playback/${session.id}`;
  return session.output === "hls" ? `${base}/manifest?generation=${session.generation}` : `${base}/stream`;
}

export function trackLabel(t: EngineTrack, kind: "audio" | "subtitle"): string {
  const lang = t.languageCode ? languageName(t.languageCode) : t.language && t.language !== "und" ? languageName(t.language) : "Unknown language";
  const parts = [lang];
  if (t.title && !t.title.toLowerCase().includes(lang.toLowerCase())) parts.push(t.title);
  if (kind === "audio") {
    parts.push(t.codec.toUpperCase().replace("EAC3", "E-AC-3").replace("AC3", "AC-3"));
    if (t.channels) parts.push(t.channels >= 8 ? "7.1" : t.channels >= 6 ? "5.1" : t.channels === 1 ? "Mono" : "Stereo");
  } else {
    if (t.forced) parts.push("Forced");
    if (t.kind === "image") parts.push("(image)");
  }
  return parts.join(" · ");
}

const LANGS: Record<string, string> = {
  en: "English", eng: "English", es: "Spanish", spa: "Spanish", fr: "French", fre: "French", fra: "French",
  de: "German", ger: "German", deu: "German", it: "Italian", ita: "Italian", ja: "Japanese", jpn: "Japanese",
  ko: "Korean", kor: "Korean", zh: "Chinese", chi: "Chinese", zho: "Chinese", pt: "Portuguese", por: "Portuguese",
  ru: "Russian", rus: "Russian", hi: "Hindi", hin: "Hindi", nl: "Dutch", dut: "Dutch", sv: "Swedish", swe: "Swedish",
  und: "Unknown",
};

export function languageName(code: string): string {
  return LANGS[code.toLowerCase()] ?? code.toUpperCase();
}

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

/** Minimal WebVTT parser (FFmpeg output): returns cues in source-timeline seconds. */
export function parseVtt(text: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const time = (t: string) => {
    const parts = t.trim().split(":").map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };
  for (const block of blocks) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split("-->");
    const start = time(a);
    const end = time(b.trim().split(/\s+/)[0]);
    const body = lines.slice(idx + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
  }
  return cues;
}
