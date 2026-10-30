/**
 * Per-profile notification preferences, stored with the profile's other preferences
 * (preferencesByProfile[profileId].notifications in the account's state file). Shared by server
 * validation and the settings UI.
 */
import type { NotificationCategory } from "./types";

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", 24-hour, in the profile's time zone. */
  start: string;
  end: string;
}

export interface NotificationPreferences {
  episodes: boolean;
  seasons: boolean;
  digital: boolean;
  physical: boolean;
  trending: boolean;
  recommendations: boolean;
  service: boolean;
  /**
   * The profile wants native browser notifications. Delivery still needs the browser's permission
   * and a registered subscription in that browser; this flag alone never shows anything.
   */
  browser: boolean;
  /** ISO 3166-1 alpha-2 region for release dates and streaming services; "" = automatic. */
  region: string;
  /** Trending titles and recommendations: one daily digest, or each title separately. */
  digest: "daily" | "instant";
  /** Browser notifications are held back during these hours (in-app notifications still arrive). */
  quietHours: QuietHours;
  /** IANA time zone reported by the profile's browser (for quiet hours); "" = UTC. */
  timeZone: string;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  episodes: true,
  seasons: true,
  digital: true,
  physical: false,
  trending: true,
  recommendations: true,
  service: true,
  browser: false,
  region: "",
  digest: "daily",
  quietHours: { enabled: true, start: "22:00", end: "08:00" },
  timeZone: "",
};

/** Region used when the profile has not chosen one and no browser region is known. */
export const FALLBACK_REGION = "US";

const REGION = /^[A-Z]{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates untrusted input; unknown or invalid fields keep `base`. */
export function normalizeNotificationPreferences(
  input: unknown,
  base: NotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES
): NotificationPreferences {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const q = (p.quietHours && typeof p.quietHours === "object" ? p.quietHours : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const region = typeof p.region === "string" ? p.region.trim().toUpperCase() : undefined;
  return {
    episodes: bool(p.episodes, base.episodes),
    seasons: bool(p.seasons, base.seasons),
    digital: bool(p.digital, base.digital),
    physical: bool(p.physical, base.physical),
    trending: bool(p.trending, base.trending),
    recommendations: bool(p.recommendations, base.recommendations),
    service: bool(p.service, base.service),
    browser: bool(p.browser, base.browser),
    region: region !== undefined && (region === "" || REGION.test(region)) ? region : base.region,
    digest: p.digest === "daily" || p.digest === "instant" ? p.digest : base.digest,
    quietHours: {
      enabled: bool(q.enabled, base.quietHours.enabled),
      start: typeof q.start === "string" && HHMM.test(q.start) ? q.start : base.quietHours.start,
      end: typeof q.end === "string" && HHMM.test(q.end) ? q.end : base.quietHours.end,
    },
    timeZone: p.timeZone === "" ? "" : validTimeZone(p.timeZone) ? p.timeZone : base.timeZone,
  };
}

export function categoryEnabled(prefs: NotificationPreferences, category: NotificationCategory): boolean {
  return prefs[category];
}

export function effectiveRegion(prefs: NotificationPreferences): string {
  return prefs.region || FALLBACK_REGION;
}

/** Minutes since midnight of `now` in `timeZone` (UTC when unknown). */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: validTimeZone(timeZone) ? timeZone : "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((x) => x.type === "hour")?.value ?? 0);
  const m = Number(parts.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Whether `now` falls inside the profile's quiet hours (a range may cross midnight). */
export function inQuietHours(prefs: NotificationPreferences, now: Date): boolean {
  const q = prefs.quietHours;
  if (!q.enabled || q.start === q.end) return false;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const t = localMinutes(now, prefs.timeZone);
  const start = toMin(q.start);
  const end = toMin(q.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** The region part of a browser locale ("en-GB" → "GB"), if any. */
export function regionFromLocale(locale: string | undefined): string {
  const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(locale ?? "");
  return m ? m[1].toUpperCase() : "";
}

/** Common regions for the settings list (TMDB supports more; any valid code is accepted). */
export const REGION_OPTIONS: Array<[string, string]> = [
  ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["IE", "Ireland"], ["AU", "Australia"], ["NZ", "New Zealand"],
  ["DE", "Germany"], ["AT", "Austria"], ["CH", "Switzerland"], ["FR", "France"], ["BE", "Belgium"], ["NL", "Netherlands"], ["ES", "Spain"],
  ["PT", "Portugal"], ["IT", "Italy"], ["SE", "Sweden"], ["NO", "Norway"], ["DK", "Denmark"], ["FI", "Finland"], ["PL", "Poland"],
  ["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"], ["IN", "India"], ["JP", "Japan"], ["KR", "South Korea"], ["ZA", "South Africa"],
];
