import { paths, secrets } from "./install/runtime";
import { readJson, writeJsonAtomic } from "./install/store.mjs";
import { HARDWARE_ACCELERATION_VALUES, readEngineConfig, updateEngineConfig } from "./install/config.mjs";
import { dataDir } from "./install/runtime";

export type HardwareAcceleration = (typeof HARDWARE_ACCELERATION_VALUES)[number];

/** Playback/engine preferences that are safe to change at runtime (no restart). */
export interface PlaybackSettings {
  /** Highest resolution to stream; larger sources are downscaled by the media engine. */
  maxResolution: number;
  playbackQuality: "best" | "balanced" | "data-saver";
  /** Video conversion backend ("auto" picks the best verified one; stored in the engine config). */
  hardwareAcceleration: HardwareAcceleration;
  /** Specific adapter for the chosen backend (null = automatic). */
  hardwareDevice: string | null;
  audioLanguage: string;
  /** ISO 639-1 code, or "off". */
  subtitleLanguage: string;
  bufferProfile: "auto" | "low" | "balanced" | "high";
  maxConcurrentTranscodes: number;
  surroundAudio: boolean;
  streamDiagnostics: boolean;
  /** Let browsers play compatible files as-is (no remux/transcode). */
  directPlay: boolean;
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  maxResolution: 2160,
  playbackQuality: "best",
  hardwareAcceleration: "auto",
  hardwareDevice: null,
  audioLanguage: "en",
  subtitleLanguage: "off",
  bufferProfile: "auto",
  maxConcurrentTranscodes: 3,
  surroundAudio: false,
  streamDiagnostics: true,
  directPlay: true,
};

/** Effective settings for server code. Credentials come from the secret store, never from requests. */
export interface ServerSettings extends PlaybackSettings {
  realDebridToken: string;
  tmdbApiKey: string;
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Validates playback settings from untrusted input, keeping `base` for anything missing/invalid. */
export function normalizePlaybackSettings(
  overlay: Partial<PlaybackSettings>,
  base: PlaybackSettings = DEFAULT_PLAYBACK_SETTINGS
): PlaybackSettings {
  return {
    maxResolution: [2160, 1440, 1080, 720, 480].includes(Number(overlay.maxResolution))
      ? Number(overlay.maxResolution)
      : base.maxResolution,
    playbackQuality: oneOf(overlay.playbackQuality, ["best", "balanced", "data-saver"] as const, base.playbackQuality),
    hardwareAcceleration: oneOf(overlay.hardwareAcceleration, HARDWARE_ACCELERATION_VALUES, base.hardwareAcceleration),
    hardwareDevice:
      overlay.hardwareDevice === null
        ? null
        : typeof overlay.hardwareDevice === "string" && /^(\d{1,2}|\/dev\/dri\/(renderD|card)\d{1,4})$/.test(overlay.hardwareDevice)
          ? overlay.hardwareDevice
          : base.hardwareDevice,
    audioLanguage: /^[a-z]{2,3}$/.test(String(overlay.audioLanguage ?? "")) ? String(overlay.audioLanguage) : base.audioLanguage,
    subtitleLanguage: /^([a-z]{2,3}|off)$/.test(String(overlay.subtitleLanguage ?? "")) ? String(overlay.subtitleLanguage) : base.subtitleLanguage,
    bufferProfile: oneOf(overlay.bufferProfile, ["auto", "low", "balanced", "high"] as const, base.bufferProfile),
    maxConcurrentTranscodes: clampInt(overlay.maxConcurrentTranscodes, 1, 8, base.maxConcurrentTranscodes),
    surroundAudio: typeof overlay.surroundAudio === "boolean" ? overlay.surroundAudio : base.surroundAudio,
    streamDiagnostics: typeof overlay.streamDiagnostics === "boolean" ? overlay.streamDiagnostics : base.streamDiagnostics,
    directPlay: typeof overlay.directPlay === "boolean" ? overlay.directPlay : base.directPlay,
  };
}

/** Playback settings: `config/playback.json`, with the engine-owned fields from `config/engine.json`. */
export function readPlaybackSettings(): PlaybackSettings {
  const file = readJson(paths().playbackConfigFile, {}) as Partial<PlaybackSettings>;
  const engine = readEngineConfig(dataDir());
  return normalizePlaybackSettings({
    ...file,
    hardwareAcceleration: engine.hardwareAcceleration as HardwareAcceleration,
    hardwareDevice: engine.hardwareDevice,
    maxConcurrentTranscodes: engine.maxConcurrentVideoTranscodes,
  });
}

export function savePlaybackSettings(next: PlaybackSettings): PlaybackSettings {
  const clean = normalizePlaybackSettings(next);
  const { hardwareAcceleration, hardwareDevice, maxConcurrentTranscodes, ...rest } = clean;
  writeJsonAtomic(paths().playbackConfigFile, rest);
  updateEngineConfig(dataDir(), {
    hardwareAcceleration,
    hardwareDevice,
    maxConcurrentVideoTranscodes: maxConcurrentTranscodes,
  });
  return clean;
}

export function getServerSettingsSync(): ServerSettings {
  const s = secrets();
  return { ...readPlaybackSettings(), realDebridToken: s.realDebridToken, tmdbApiKey: s.tmdbApiKey };
}

/**
 * Settings view for the browser. Credentials are never included — only whether they are configured.
 */
export function toClientSettings(settings: ServerSettings) {
  return {
    realDebridConfigured: Boolean(settings.realDebridToken),
    tmdbConfigured: Boolean(settings.tmdbApiKey),
    maxResolution: settings.maxResolution,
    playbackQuality: settings.playbackQuality,
    hardwareAcceleration: settings.hardwareAcceleration,
    audioLanguage: settings.audioLanguage,
    subtitleLanguage: settings.subtitleLanguage,
    bufferProfile: settings.bufferProfile,
    maxConcurrentTranscodes: settings.maxConcurrentTranscodes,
    surroundAudio: settings.surroundAudio,
    streamDiagnostics: settings.streamDiagnostics,
    directPlay: settings.directPlay,
  };
}

export type ClientSettingsView = ReturnType<typeof toClientSettings>;
