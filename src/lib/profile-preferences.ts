/**
 * Per-profile playback preferences (audio/subtitle languages, subtitle look, autoplay). Stored in
 * the user's state file on the server under preferencesByProfile and mirrored in the client store.
 * Shared by server validation and client UI; no secrets or media links ever live here.
 */

export type SubtitleSize = "small" | "medium" | "large" | "xlarge";
export type SubtitleColor = "white" | "yellow" | "cyan";
export type SubtitleBackground = "none" | "semi" | "solid";
export type SubtitleEdge = "none" | "outline" | "shadow";

export interface SubtitleStyle {
  size: SubtitleSize;
  color: SubtitleColor;
  background: SubtitleBackground;
  edge: SubtitleEdge;
}

/** Remembered choices for one title (keyed by watch id). */
export interface TitlePreferences {
  audioLanguage?: string;
  /** Two-letter code, or "off". */
  subtitleLanguage?: string;
  /** Info hash (or hash) of the last chosen release; never a URL. */
  sourceHash?: string;
  updatedAt: number;
}

export interface ProfilePreferences {
  /** Two-letter ISO 639-1 codes. */
  audioLanguage: string;
  secondaryAudioLanguage: string;
  preferOriginalAudio: boolean;
  preferSurround: boolean;
  /** Keep per-title audio/subtitle choices between sessions. */
  rememberLanguage: boolean;
  /** Two-letter code; "off" disables subtitles by default. */
  subtitleLanguage: string;
  subtitlesEnabled: boolean;
  /** Prefer forced (foreign-parts-only) subtitle tracks when they exist. */
  forcedSubtitles: boolean;
  subtitleStyle: SubtitleStyle;
  /** Positive shows subtitles later. */
  subtitleOffsetMs: number;
  autoplayPreviews: boolean;
  autoplayNextEpisode: boolean;
  titlePrefs: Record<string, TitlePreferences>;
}

export const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  audioLanguage: "en",
  secondaryAudioLanguage: "",
  preferOriginalAudio: false,
  preferSurround: false,
  rememberLanguage: true,
  subtitleLanguage: "en",
  subtitlesEnabled: false,
  forcedSubtitles: true,
  subtitleStyle: { size: "medium", color: "white", background: "semi", edge: "outline" },
  subtitleOffsetMs: 0,
  autoplayPreviews: false,
  autoplayNextEpisode: true,
  titlePrefs: {},
};

export const LANGUAGE_OPTIONS: Array<[code: string, label: string]> = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["pt", "Portuguese"], ["ru", "Russian"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
  ["hi", "Hindi"], ["nl", "Dutch"], ["sv", "Swedish"], ["pl", "Polish"], ["tr", "Turkish"], ["ar", "Arabic"],
  ["uk", "Ukrainian"], ["cs", "Czech"], ["da", "Danish"], ["fi", "Finnish"], ["no", "Norwegian"],
];

const LANG = /^[a-z]{2}$/;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Validates untrusted input; unknown or invalid fields keep `base`. */
export function normalizeProfilePreferences(
  input: unknown,
  base: ProfilePreferences = DEFAULT_PROFILE_PREFERENCES
): ProfilePreferences {
  const p = (input ?? {}) as Record<string, unknown>;
  const style = (p.subtitleStyle ?? {}) as Record<string, unknown>;
  const lang = (v: unknown, fallback: string, allowOff = false) =>
    typeof v === "string" && (LANG.test(v) || (allowOff && v === "off") || v === "") ? v : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const titlePrefs: Record<string, TitlePreferences> = { ...base.titlePrefs };
  if (p.titlePrefs && typeof p.titlePrefs === "object") {
    for (const [key, raw] of Object.entries(p.titlePrefs as Record<string, unknown>).slice(0, 500)) {
      if (!raw || typeof raw !== "object" || key.length > 200) continue;
      const t = raw as Record<string, unknown>;
      titlePrefs[key] = {
        audioLanguage: lang(t.audioLanguage, "") || undefined,
        subtitleLanguage: lang(t.subtitleLanguage, "", true) || undefined,
        sourceHash: typeof t.sourceHash === "string" && /^[a-f0-9]{8,64}$/i.test(t.sourceHash) ? t.sourceHash.toLowerCase() : undefined,
        updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
      };
    }
  }
  return {
    audioLanguage: lang(p.audioLanguage, base.audioLanguage) || base.audioLanguage,
    secondaryAudioLanguage: lang(p.secondaryAudioLanguage, base.secondaryAudioLanguage),
    preferOriginalAudio: bool(p.preferOriginalAudio, base.preferOriginalAudio),
    preferSurround: bool(p.preferSurround, base.preferSurround),
    rememberLanguage: bool(p.rememberLanguage, base.rememberLanguage),
    subtitleLanguage: lang(p.subtitleLanguage, base.subtitleLanguage, true) || base.subtitleLanguage,
    subtitlesEnabled: bool(p.subtitlesEnabled, base.subtitlesEnabled),
    forcedSubtitles: bool(p.forcedSubtitles, base.forcedSubtitles),
    subtitleStyle: {
      size: oneOf(style.size, ["small", "medium", "large", "xlarge"] as const, base.subtitleStyle.size),
      color: oneOf(style.color, ["white", "yellow", "cyan"] as const, base.subtitleStyle.color),
      background: oneOf(style.background, ["none", "semi", "solid"] as const, base.subtitleStyle.background),
      edge: oneOf(style.edge, ["none", "outline", "shadow"] as const, base.subtitleStyle.edge),
    },
    subtitleOffsetMs: typeof p.subtitleOffsetMs === "number" && Number.isFinite(p.subtitleOffsetMs)
      ? Math.max(-30_000, Math.min(30_000, Math.round(p.subtitleOffsetMs)))
      : base.subtitleOffsetMs,
    autoplayPreviews: bool(p.autoplayPreviews, base.autoplayPreviews),
    autoplayNextEpisode: bool(p.autoplayNextEpisode, base.autoplayNextEpisode),
    titlePrefs,
  };
}

/** Ordered audio languages for a profile (primary, then secondary). */
export function orderedAudioLanguages(prefs: ProfilePreferences, titleOverride?: string): string[] {
  return [titleOverride, prefs.audioLanguage, prefs.secondaryAudioLanguage]
    .filter((l): l is string => Boolean(l) && LANG.test(l!))
    .filter((l, i, all) => all.indexOf(l) === i);
}

/** CSS for WebVTT cues (applies to native and sidecar tracks). */
export function subtitleCueCss(style: SubtitleStyle): string {
  const size = { small: "1.4vmin", medium: "2.2vmin", large: "3vmin", xlarge: "3.8vmin" }[style.size];
  const color = { white: "#fff", yellow: "#ffe14d", cyan: "#7fe7ff" }[style.color];
  const background = { none: "transparent", semi: "rgba(0,0,0,0.55)", solid: "rgba(0,0,0,0.95)" }[style.background];
  const edge = {
    none: "none",
    outline: "0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000",
    shadow: "2px 2px 4px rgba(0,0,0,0.9)",
  }[style.edge];
  return `video::cue { font-size: ${size}; color: ${color}; background-color: ${background}; text-shadow: ${edge}; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.3; }`;
}
