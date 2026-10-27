import "server-only";
import path from "node:path";
import { paths, saveSecrets, secrets, serverConfig } from "../install/runtime";
import { getUserById, listUsers, readUserState } from "../users";
import { profileMaturity } from "../maturity";
import { normalizeProfilePreferences } from "../profile-preferences";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "./preferences";
import type { AccountView, JobContext, ProfileView } from "./jobs";
import { NotificationScheduler } from "./scheduler";
import { createTmdbClient, type TmdbClient } from "./tmdb-client";
import { generateVapidKeys, validVapidKeys, type VapidKeys } from "./webpush";

/** <data>/db/notifications */
export function notificationsDir(): string {
  return path.join(paths().dbDir, "notifications");
}

/** Profiles as the jobs need them (read-only view of each account's state file). */
export function accountViews(): AccountView[] {
  const out: AccountView[] = [];
  for (const user of listUsers()) {
    let state;
    try {
      state = readUserState(user.id);
    } catch {
      continue;
    }
    const profiles: ProfileView[] = state.profiles.map((p) => {
      const prefs = normalizeProfilePreferences(state.preferencesByProfile?.[p.id]).notifications ?? DEFAULT_NOTIFICATION_PREFERENCES;
      const watched = Object.entries(state.lastWatchedByProfile?.[p.id] ?? {})
        .map(([watchId, e]) => {
          const tv = /^tmdb-tv-(\d+)$/.exec(watchId);
          const movie = /^tmdb-(\d+)$/.exec(watchId);
          const tmdbId = e.item?.tmdbId ?? Number(tv?.[1] ?? movie?.[1] ?? NaN);
          const mediaType: "movie" | "tv" | null = e.item?.mediaType ?? (tv ? "tv" : movie ? "movie" : e.item?.type === "series" ? "tv" : e.item?.type === "movie" ? "movie" : null);
          return Number.isFinite(tmdbId) && mediaType ? { tmdbId, mediaType, title: e.item?.title ?? "", at: e.updatedAt ?? 0 } : null;
        })
        .filter((w): w is NonNullable<typeof w> => w !== null)
        .sort((a, b) => b.at - a.at);
      return {
        id: p.id,
        name: p.name,
        isKids: Boolean(p.isKids),
        maturity: profileMaturity(p),
        prefs,
        myList: state.myListByProfile[p.id] ?? [],
        watched,
      };
    });
    out.push({ id: user.id, role: user.role, profiles, sessionVersion: getUserById(user.id)?.sessionVersion ?? 0 });
  }
  return out;
}

const g = globalThis as unknown as {
  __notflixNotify?: { scheduler?: NotificationScheduler; tmdb?: { key: string; client: TmdbClient }; vapid?: VapidKeys };
};
const shared = (g.__notflixNotify ??= {});

/**
 * The VAPID key pair (generated once, kept in the encrypted credential store). The public half is
 * given to browsers; the private half never leaves the server.
 */
export function vapidKeys(): VapidKeys {
  if (shared.vapid) return shared.vapid;
  const s = secrets();
  let keys: VapidKeys = { publicKey: s.vapidPublicKey, privateKey: s.vapidPrivateKey };
  if (!validVapidKeys(keys)) {
    keys = generateVapidKeys();
    saveSecrets({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey });
  }
  return (shared.vapid = keys);
}

/** Contact the push services may use (RFC 8292 "sub"); NOTFLIX_PUSH_CONTACT overrides it. */
export function pushSubject(): string {
  const v = process.env.NOTFLIX_PUSH_CONTACT?.trim();
  return v && /^(mailto:|https:\/\/)/.test(v) ? v : "https://github.com/jdepew88/notflix-debrid";
}

function tmdbClient(): TmdbClient | null {
  const key = secrets().tmdbApiKey;
  if (!key) return null;
  if (shared.tmdb?.key !== key) shared.tmdb = { key, client: createTmdbClient({ apiKey: key }) };
  return shared.tmdb.client;
}

export function jobContext(): JobContext | null {
  if (!serverConfig().setup.completed) return null;
  return {
    dir: notificationsDir(),
    now: () => new Date(),
    tmdb: tmdbClient(),
    accounts: accountViews,
    log: (m) => console.log(`[notflix] ${m}`),
    serviceAlerts: async () => {
      const { configAlerts } = await import("../install/alerts");
      return (await configAlerts()).map((a) => ({ id: a.id, message: a.message, href: a.href }));
    },
    push: (() => {
      try {
        return { keys: vapidKeys(), subject: pushSubject() };
      } catch {
        return null;
      }
    })(),
  };
}

export function scheduler(): NotificationScheduler {
  return (shared.scheduler ??= new NotificationScheduler({ ctx: jobContext }));
}

/**
 * Starts the background jobs (from instrumentation.ts). NOTFLIX_NOTIFICATIONS=0 turns them off;
 * NOTFLIX_NOTIFY_START_DELAY_MS sets the delay before the first check (default 2 minutes, so a
 * slow or unreachable TMDB never affects startup).
 */
export function startNotifications(): void {
  if (/^(0|false|off|no)$/i.test(process.env.NOTFLIX_NOTIFICATIONS ?? "")) {
    console.log("[notflix] Notification checks are turned off (NOTFLIX_NOTIFICATIONS).");
    return;
  }
  const delay = Number(process.env.NOTFLIX_NOTIFY_START_DELAY_MS);
  scheduler().start(Number.isFinite(delay) && delay >= 0 ? delay : 120_000);
  // A normal stop hands the lease back at once (after a crash it simply expires within 5 minutes).
  process.once("exit", () => scheduler().stop());
}
