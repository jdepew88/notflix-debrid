import { getServerSettingsSync, type ServerSettings } from "./server-settings";

export type { ServerSettings as ResolvedSettings };

/**
 * Effective settings for a request. Settings (including every credential) are stored on the
 * server; requests cannot override them through headers, cookies or query strings.
 */
export function mergeSettings(): ServerSettings {
  return getServerSettingsSync();
}

/** Kept for call-site compatibility: identical to mergeSettings now that Plex is gone. */
export function mergeSettingsForServerOps(): ServerSettings {
  return getServerSettingsSync();
}

export { getServerSettingsSync };
