/**
 * Ranks Real-Debrid/Torrentio releases for automatic playback. Pure functions (unit tested).
 *
 * The media engine can play practically any codec, so ranking is about what makes playback start
 * fast and look right: instantly available (cached) releases first, the user's resolution limit,
 * sensible file sizes for the chosen quality, and real releases over CAM/TS. Browser-native formats
 * (H.264/AAC MP4) get a small bonus because they direct-play with no server work.
 */

export interface StreamTraits {
  resolution: number | null;
  sizeGb: number | null;
  cached: boolean;
  uncached: boolean;
  videoCodec: "h264" | "hevc" | "av1" | "other" | null;
  hdr: boolean;
  dolbyVision: boolean;
  remux: boolean;
  webSource: boolean;
  lowQualitySource: "cam" | "ts" | "scr" | null;
  audio: "aac" | "ac3" | "eac3" | "dts" | "truehd" | "atmos" | null;
  container: "mp4" | "mkv" | "avi" | null;
  seeders: number | null;
}

export interface RankingPreferences {
  maxResolution: number;
  quality: "best" | "balanced" | "data-saver";
  /** Browser can decode HEVC natively (copy instead of GPU transcode). */
  hevcSupported?: boolean;
  /** Preferred audio languages (two-letter), most preferred first. */
  audioLanguages?: string[];
}

/**
 * Language hints read from a release name. These are hints, not facts: "RUS" in a name is a strong
 * sign of Russian audio, but nothing in a name proves English audio exists. Verified track data
 * (ffprobe) always overrides them.
 */
export interface LanguageHints {
  /** Two-letter codes the name mentions (flags, words, ISO codes). */
  codes: string[];
  /** "MULTi", "Dual Audio", several flags… */
  multi: boolean;
  /** Looks like a dubbed/foreign-only release (language tag with no English marker). */
  likelyNonEnglishOnly: boolean;
}

const FLAG_CODES: Record<string, string> = {
  "🇬🇧": "en", "🇺🇸": "en", "🇦🇺": "en", "🇨🇦": "en", "🇷🇺": "ru", "🇫🇷": "fr", "🇩🇪": "de", "🇪🇸": "es", "🇲🇽": "es",
  "🇮🇹": "it", "🇵🇹": "pt", "🇧🇷": "pt", "🇯🇵": "ja", "🇰🇷": "ko", "🇨🇳": "zh", "🇮🇳": "hi", "🇳🇱": "nl", "🇸🇪": "sv",
  "🇵🇱": "pl", "🇹🇷": "tr", "🇸🇦": "ar", "🇺🇦": "uk", "🇨🇿": "cs", "🇩🇰": "da", "🇫🇮": "fi", "🇳🇴": "no", "🇭🇺": "hu", "🇹🇭": "th", "🇻🇳": "vi",
};

const WORD_CODES: Array<[RegExp, string]> = [
  [/\b(eng|english|en)\b/i, "en"],
  [/\b(rus|russian|ru)\b|русск/i, "ru"],
  [/\b(fre|fra|french|vf|vff|vfq|truefrench|fr)\b/i, "fr"],
  [/\b(ger|deu|german|de)\b/i, "de"],
  [/\b(spa|spanish|esp|castellano|latino|lat|es)\b/i, "es"],
  [/\b(ita|italian|it)\b/i, "it"],
  [/\b(por|portuguese|pt-br|pt)\b/i, "pt"],
  [/\b(jpn|japanese|jap|ja)\b/i, "ja"],
  [/\b(kor|korean|ko)\b/i, "ko"],
  [/\b(chi|zho|chinese|mandarin|cantonese|zh)\b/i, "zh"],
  [/\b(hin|hindi|hi)\b/i, "hi"],
  [/\b(ukr|ukrainian|uk)\b/i, "uk"],
  [/\b(pol|polish|pl)\b/i, "pl"],
  [/\b(tur|turkish|tr)\b/i, "tr"],
  [/\b(tam|tamil|tel|telugu)\b/i, "ta"],
];

export function parseLanguageHints(text: string): LanguageHints {
  const codes = new Set<string>();
  for (const [flag, code] of Object.entries(FLAG_CODES)) if (text.includes(flag)) codes.add(code);
  // Only the tail of a release name carries language tags; the title itself can contain words like "It".
  const tail = text.replace(/^[^\n]*?(\b(19|20)\d{2}\b|\bS\d{2}E?\d{0,2}\b)/i, "");
  for (const [re, code] of WORD_CODES) if (re.test(tail)) codes.add(code);
  const multi = /\b(multi|dual[\s.-]?audio|dual|dub(bed)?)\b/i.test(text) || codes.size > 1;
  const nonEnglish = [...codes].filter((c) => c !== "en");
  return {
    codes: [...codes],
    multi,
    likelyNonEnglishOnly: nonEnglish.length > 0 && !codes.has("en") && !multi,
  };
}

/** Score contribution of release-name language hints for the given preferences (unverified). */
export function languageHintScore(hints: LanguageHints, preferred: string[] | undefined): number {
  if (!preferred?.length) return 0;
  const wants = new Set(preferred);
  if (hints.codes.some((c) => wants.has(c))) return 60;
  if (hints.multi && hints.codes.length === 0) return 15; // "MULTi" without specifics: probably includes it
  if (hints.likelyNonEnglishOnly && !hints.codes.some((c) => wants.has(c))) return -500;
  return 0;
}

/**
 * Score contribution of verified (ffprobe) audio languages. Dominates everything but availability:
 * a 1080p release with confirmed English beats a 4K release with only Russian.
 */
export function verifiedLanguageScore(verifiedLanguages: string[], untaggedTracks: number, preferred: string[] | undefined): number {
  if (!preferred?.length) return 0;
  const idx = preferred.findIndex((l) => verifiedLanguages.includes(l));
  if (idx === 0) return 700;
  if (idx > 0) return 450;
  if (verifiedLanguages.length === 0 && untaggedTracks > 0) return -40; // unknown, not wrong
  return -600;
}

export function parseStreamTraits(text: string): StreamTraits {
  const t = text.toLowerCase();
  let resolution: number | null = null;
  if (/\b(2160p|4k|uhd)\b/.test(t)) resolution = 2160;
  else if (/\b1440p\b/.test(t)) resolution = 1440;
  else if (/\b1080p\b/.test(t)) resolution = 1080;
  else if (/\b720p\b/.test(t)) resolution = 720;
  else if (/\b(480p|576p|sd)\b/.test(t)) resolution = 480;

  let sizeGb: number | null = null;
  const size = /(\d+(?:\.\d+)?)\s*(gb|mb)\b/.exec(t);
  if (size) sizeGb = size[2] === "gb" ? parseFloat(size[1]) : parseFloat(size[1]) / 1024;

  const seedMatch = /👤\s*(\d+)/.exec(text);

  return {
    resolution,
    sizeGb,
    // Torrentio marks cached Real-Debrid results "[RD+]" and uncached ones "[RD download]".
    cached: /\[rd\+\]/.test(t) || t.includes("⚡") || /\binstant\b/.test(t),
    uncached: /\[rd download\]/.test(t) || t.includes("⬇") || /\bdownload\]/.test(t),
    videoCodec: /\b(x265|h\.?265|hevc)\b/.test(t) ? "hevc" : /\b(x264|h\.?264|avc)\b/.test(t) ? "h264" : /\bav1\b/.test(t) ? "av1" : /\b(xvid|divx|mpeg2|vc-?1)\b/.test(t) ? "other" : null,
    hdr: /\b(hdr|hdr10|hdr10\+|hlg)\b/.test(t),
    dolbyVision: /\b(dv|dovi|dolby\s?vision)\b/.test(t),
    remux: /\bremux\b/.test(t),
    webSource: /\b(web-?dl|webrip|web)\b/.test(t),
    lowQualitySource: /\b(cam|camrip|hdcam)\b/.test(t) ? "cam" : /\b(telesync|hdts|ts|telecine|tc)\b/.test(t) ? "ts" : /\b(screener|scr|dvdscr)\b/.test(t) ? "scr" : null,
    audio: /\batmos\b/.test(t) ? "atmos" : /\btruehd\b/.test(t) ? "truehd" : /\bdts/.test(t) ? "dts" : /\b(eac3|e-ac-3|ddp|dd\+)/.test(t) ? "eac3" : /\b(ac3|dd5\.1|dd)\b/.test(t) ? "ac3" : /\baac\b/.test(t) ? "aac" : null,
    container: /\.mp4\b|\bmp4\b/.test(t) ? "mp4" : /\.mkv\b|\bmkv\b/.test(t) ? "mkv" : /\.avi\b/.test(t) ? "avi" : null,
    seeders: seedMatch ? parseInt(seedMatch[1], 10) : null,
  };
}

/** Comfortable size ceilings (GB) for a feature film by quality preference. */
const SIZE_CEILING_GB: Record<RankingPreferences["quality"], number> = {
  best: 40,
  balanced: 20,
  "data-saver": 6,
};

export function playbackScore(traits: StreamTraits, prefs: RankingPreferences): number {
  let score = 0;

  // Availability dominates: an uncached torrent means waiting for Real-Debrid to download it.
  if (traits.cached) score += 1000;
  if (traits.uncached) score -= 2000;

  // Resolution: as close to the limit as possible without exceeding it.
  const limit = prefs.quality === "data-saver" ? Math.min(prefs.maxResolution, 720) : prefs.maxResolution;
  const res = traits.resolution ?? 720;
  if (res > limit) score -= 150 + (res - limit) / 10; // still playable (engine downscales), just not preferred
  else score += res / 10; // 2160→216, 1080→108

  if (prefs.quality === "balanced" && res > 1080) score -= 60;

  // Low-quality sources are a last resort.
  if (traits.lowQualitySource === "cam") score -= 600;
  else if (traits.lowQualitySource === "ts") score -= 450;
  else if (traits.lowQualitySource === "scr") score -= 250;

  // Size: very large files start slower and stress the connection; tiny ones look bad.
  if (traits.sizeGb != null) {
    const ceiling = SIZE_CEILING_GB[prefs.quality];
    if (traits.sizeGb > ceiling) score -= Math.min(200, (traits.sizeGb - ceiling) * 5);
    if (traits.sizeGb < 0.4) score -= 80;
  }
  if (traits.remux) score -= prefs.quality === "best" ? 25 : 70;

  // Compatibility: native formats need no server work and start fastest.
  if (traits.videoCodec === "h264") score += 25;
  if (traits.videoCodec === "hevc") score += prefs.hevcSupported ? 20 : 5;
  if (traits.videoCodec === "av1") score += 10;
  if (traits.videoCodec === "other") score -= 40;
  if (traits.audio === "aac") score += 15;
  if (traits.container === "mp4") score += 10;
  if (traits.container === "avi") score -= 20;
  if (traits.webSource) score += 8;
  // Dolby Vision profile 5 web releases need conversion and often lack an HDR10 fallback.
  if (traits.dolbyVision && !traits.hdr) score -= 30;

  if (traits.seeders != null) score += Math.min(20, Math.log10(traits.seeders + 1) * 8);
  return score;
}

/** Full automatic-selection score: traits + name hints + (when known) verified track languages. */
export function candidateScore(
  text: string,
  prefs: RankingPreferences,
  verified?: { audioLanguages: string[]; untaggedAudioTracks: number } | null
): number {
  const traits = parseStreamTraits(text);
  let score = playbackScore(traits, prefs);
  score += verified ? verifiedLanguageScore(verified.audioLanguages, verified.untaggedAudioTracks, prefs.audioLanguages) : languageHintScore(parseLanguageHints(text), prefs.audioLanguages);
  return score;
}

export interface RankableStream {
  name?: string;
  title?: string;
  url?: string;
}

/** Returns indices of `streams` in preferred playback order. */
export function rankStreamsForPlayback<T extends RankableStream>(streams: T[], prefs: RankingPreferences): number[] {
  return streams
    .map((s, i) => ({ i, score: candidateScore(`${s.name ?? ""} ${s.title ?? ""}`, prefs) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.i);
}
