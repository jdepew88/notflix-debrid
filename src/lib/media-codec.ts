import type { ProbeResult, StreamTrack } from "@/types/media-tracks";

const BROWSER_AUDIO = new Set(["aac", "mp3", "opus"]);
const TRANSCODE_AUDIO = new Set([
  "ac3",
  "eac3",
  "dts",
  "truehd",
  "dts_hd_ma",
  "dts-hd",
  "dts_hd",
  "pcm_s16le",
  "pcm_s24le",
  "flac",
  "vorbis",
]);
const BROWSER_VIDEO = new Set(["h264", "avc"]);
const HLS_VIDEO_COPY = new Set(["h264", "hevc", "h265", "avc"]);

const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "text",
]);

export function isBrowserVideoCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  if (BROWSER_VIDEO.has(c)) return true;
  if (c.startsWith("h264") || c.includes("avc")) return true;
  return false;
}

export function videoNeedsBrowserTranscode(videoCodec?: string, formatName?: string): boolean {
  if (videoCodec) return !isBrowserVideoCodec(videoCodec);
  if (!formatName) return false;
  return /avi|xvid|asf|wmv|mpeg|hevc|h265/i.test(formatName);
}

export function isHlsVideoCopySafe(codec: string): boolean {
  const c = codec.toLowerCase();
  if (HLS_VIDEO_COPY.has(c)) return true;
  if (c.startsWith("h264") || c.includes("avc") || c.startsWith("hevc") || c.includes("h265")) {
    return true;
  }
  return false;
}

export function isBrowserAudioCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  if (TRANSCODE_AUDIO.has(c)) return false;
  return BROWSER_AUDIO.has(c);
}

export function trackNeedsTranscode(track: StreamTrack | undefined): boolean {
  if (!track) return true;
  if ((track.channels ?? 0) > 2) return true;
  return !isBrowserAudioCodec(track.codec);
}

export function containerPrefersTranscode(formatName: string): boolean {
  return /matroska|webm|avi|mpegts|m2ts/i.test(formatName);
}

export function isTextSubtitleCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  return TEXT_SUBTITLE_CODECS.has(c) || c.includes("subrip");
}

export function isEnglishLanguage(value?: string): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  if (["en", "eng", "english"].includes(normalized)) return true;
  const primary = normalized.split(/[-_]/)[0];
  return primary === "en" || primary === "eng";
}

const NON_ENGLISH_AUDIO_HINTS = [
  "french",
  "français",
  "german",
  "deutsch",
  "spanish",
  "español",
  "italian",
  "japanese",
  "korean",
  "chinese",
  "mandarin",
  "cantonese",
  "hindi",
  "russian",
  "portuguese",
  "polish",
  "dutch",
  "nordic",
  "swedish",
  "danish",
  "norwegian",
  "finnish",
  "turkish",
  "arabic",
  "thai",
  "vietnamese",
];

function trackMatchesEnglish(track: StreamTrack): boolean {
  const label = `${track.language ?? ""} ${track.title ?? ""}`.toLowerCase();
  if (NON_ENGLISH_AUDIO_HINTS.some((hint) => label.includes(hint))) return false;
  return isEnglishLanguage(track.language) || isEnglishLanguage(track.title);
}

function audioTrackPreferenceScore(track: StreamTrack): number {
  let score = 0;
  const codec = track.codec.toLowerCase();
  const english = trackMatchesEnglish(track);
  const lang = track.language?.toLowerCase().trim() ?? "";
  const title = (track.title ?? "").toLowerCase();

  if (english) score += 60;
  if (lang === "und" || lang === "") {
    if (!NON_ENGLISH_AUDIO_HINTS.some((hint) => title.includes(hint))) score += 12;
  }
  if (codec === "aac" || isBrowserAudioCodec(codec)) score += 35;
  if (track.channels === 2) score += 6;
  if (track.default && english) score += 20;
  if (track.default && !english) score -= 25;
  if (track.forced && !english) score -= 40;
  if (TRANSCODE_AUDIO.has(codec)) score -= 8;
  if (title.includes("commentary")) score -= 30;
  if (title.includes("descriptive") || title.includes("ad")) score -= 15;

  return score;
}

export function defaultSubtitleTrack(subtitles: StreamTrack[]): number | null {
  if (subtitles.length === 0) return null;

  const english = subtitles.filter(trackMatchesEnglish);
  if (english.length > 0) {
    return (
      english.find((t) => t.default && !t.forced)?.index ??
      english.find((t) => !t.forced)?.index ??
      english[0].index
    );
  }

  const def = subtitles.find((t) => t.default);
  if (def) return def.index;
  return subtitles[0].index;
}

export function defaultAudioTrack(audio: StreamTrack[]): number {
  if (audio.length === 0) return 0;
  if (audio.length === 1) return audio[0].index;

  const ranked = [...audio].sort(
    (a, b) => audioTrackPreferenceScore(b) - audioTrackPreferenceScore(a)
  );
  return ranked[0].index;
}

export function subtitleStreamOrdinal(subtitles: StreamTrack[], absoluteIndex: number): number {
  const idx = subtitles.findIndex((s) => s.index === absoluteIndex);
  return idx >= 0 ? idx : 0;
}

export function trackResponseDefaults(probe: ProbeResult) {
  const defaultSubtitleIndex = defaultSubtitleTrack(probe.subtitles);
  return {
    ...probe,
    defaultAudioIndex: defaultAudioTrack(probe.audio),
    defaultSubtitleIndex,
    needsSubtitles: defaultSubtitleIndex !== null,
  };
}
