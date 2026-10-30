/**
 * Durable notification storage in the data folder, next to the accounts:
 *
 *   <data>/db/notifications/inbox/<accountId>.json   per-profile notifications, read/dismissed state,
 *                                                    delivered keys (dedupe), follows, suppressions
 *   <data>/db/notifications/state.json               background-job state and metadata snapshots
 *   <data>/db/notifications/lease.json               which process runs the background jobs
 *   <data>/db/notifications/push.json                browser push subscriptions
 *
 * Every read-modify-write holds a cross-process file lock and writes atomically (the same helpers
 * as the account store), so the web server, a second process and the CLI never lose updates.
 * Plain Node.js (no Next.js imports) so tests and tools can use it directly.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../install/store.mjs";
import type { NotificationCategory, NotificationContent, NotificationPage, NotificationView, StoredNotification } from "./types";

export const INBOX_VERSION = 1;
/** Newest notifications kept per profile (older ones are dropped, their dedupe keys are kept). */
export const MAX_PER_PROFILE = 300;
/** Dedupe keys are remembered this long, so an old event is never announced again. */
const KEY_RETENTION_MS = 400 * 86_400_000;
const SUPPRESS_RETENTION_MS = 365 * 86_400_000;

/** Daily limits per profile and category (a digest counts as one). */
export const DAILY_LIMITS: Record<NotificationCategory, number> = {
  episodes: 25,
  seasons: 10,
  digital: 5,
  physical: 3,
  trending: 3,
  recommendations: 3,
  service: 5,
};

export interface ProfileInbox {
  items: StoredNotification[];
  /** dedupeKey → when it was delivered or deliberately skipped (limits, maturity, preferences). */
  keys: Record<string, number>;
  /** Series followed explicitly: "tv:<tmdbId>" → { at, title }. */
  follows: Record<string, { at: number; title?: string }>;
  /** Series the profile stopped following although they are in My List / Continue Watching. */
  muted: Record<string, number>;
  /** Titles not to suggest again ("movie:<id>", "tv:<id>"): dismissed suggestions. */
  suppressed: Record<string, number>;
  /** Per-category counts for the current UTC day. */
  counters: Record<string, { day: string; count: number }>;
}

interface InboxFile {
  version: number;
  profiles: Record<string, ProfileInbox>;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function inboxFile(dir: string, accountId: string): string {
  if (!ID_RE.test(accountId)) throw new Error("Invalid account id");
  return path.join(dir, "inbox", `${accountId}.json`);
}

function emptyInbox(): ProfileInbox {
  return { items: [], keys: {}, follows: {}, muted: {}, suppressed: {}, counters: {} };
}

function normalizeInbox(raw: unknown): ProfileInbox {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ProfileInbox>;
  const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {});
  return {
    items: Array.isArray(r.items) ? r.items.filter((i) => i && typeof i.id === "string" && typeof i.dedupeKey === "string") : [],
    keys: obj<number>(r.keys),
    follows: obj(r.follows),
    muted: obj<number>(r.muted),
    suppressed: obj<number>(r.suppressed),
    counters: obj(r.counters),
  };
}

function readInboxFile(dir: string, accountId: string): InboxFile {
  const raw = readJson(inboxFile(dir, accountId), null) as InboxFile | null;
  const profiles: Record<string, ProfileInbox> = {};
  if (raw && typeof raw === "object" && raw.profiles && typeof raw.profiles === "object") {
    for (const [id, inbox] of Object.entries(raw.profiles)) if (ID_RE.test(id)) profiles[id] = normalizeInbox(inbox);
  }
  return { version: INBOX_VERSION, profiles };
}

/** Locked read-modify-write of one account's notification file. */
export function updateInboxFile<T>(dir: string, accountId: string, fn: (file: InboxFile) => T): T {
  const file = inboxFile(dir, accountId);
  return withFileLock(`${file}.lock`, () => {
    const data = readInboxFile(dir, accountId);
    const result = fn(data);
    writeJsonAtomic(file, data);
    return result;
  });
}

function updateProfileInbox<T>(dir: string, accountId: string, profileId: string, fn: (inbox: ProfileInbox) => T): T {
  if (!ID_RE.test(profileId)) throw new Error("Invalid profile id");
  return updateInboxFile(dir, accountId, (data) => {
    const inbox = (data.profiles[profileId] ??= emptyInbox());
    return fn(inbox);
  });
}

export function readProfileInbox(dir: string, accountId: string, profileId: string): ProfileInbox {
  return readInboxFile(dir, accountId).profiles[profileId] ?? emptyInbox();
}

/** Stable per-profile notification id (the same event always gets the same id). */
export function notificationId(profileId: string, dedupeKey: string): string {
  return crypto.createHash("sha256").update(`${profileId}\n${dedupeKey}`).digest("hex").slice(0, 24);
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export interface DeliveryOptions {
  now: Date;
  /** Category switched on for this profile? (Disabled categories are not recorded as delivered.) */
  enabled: (category: NotificationCategory) => boolean;
  /** Whether the profile may see this (maturity). Refused items are remembered as skipped. */
  allowed?: (content: NotificationContent) => boolean;
  /** Queue a browser push for each delivered notification. */
  push?: boolean;
  limits?: Record<NotificationCategory, number>;
}

export interface DeliveryResult {
  delivered: StoredNotification[];
  duplicates: number;
  limited: number;
  refused: number;
  disabled: number;
}

/**
 * Adds notifications to a profile's inbox. A dedupe key that was delivered (or deliberately skipped)
 * before is never added again, however often a job runs. Notifications from a disabled category
 * are not remembered, so turning the category on later still announces future events.
 */
export function deliver(dir: string, accountId: string, profileId: string, contents: NotificationContent[], opts: DeliveryOptions): DeliveryResult {
  const limits = opts.limits ?? DAILY_LIMITS;
  const day = utcDay(opts.now);
  const at = opts.now.getTime();
  return updateProfileInbox(dir, accountId, profileId, (inbox) => {
    const result: DeliveryResult = { delivered: [], duplicates: 0, limited: 0, refused: 0, disabled: 0 };
    const seenNow = new Set<string>();
    for (const c of contents) {
      if (inbox.keys[c.dedupeKey] !== undefined || seenNow.has(c.dedupeKey)) {
        result.duplicates++;
        continue;
      }
      seenNow.add(c.dedupeKey);
      if (!opts.enabled(c.category)) {
        result.disabled++;
        continue;
      }
      if (c.subject && inbox.suppressed[c.subject] !== undefined && (c.category === "trending" || c.category === "recommendations")) {
        inbox.keys[c.dedupeKey] = at;
        result.refused++;
        continue;
      }
      if (opts.allowed && !opts.allowed(c)) {
        inbox.keys[c.dedupeKey] = at;
        result.refused++;
        continue;
      }
      const counter = inbox.counters[c.category];
      const count = counter?.day === day ? counter.count : 0;
      if (count >= limits[c.category]) {
        inbox.keys[c.dedupeKey] = at;
        result.limited++;
        continue;
      }
      inbox.counters[c.category] = { day, count: count + 1 };
      inbox.keys[c.dedupeKey] = at;
      const { ttlDays, ...content } = c;
      const stored: StoredNotification = {
        ...content,
        id: notificationId(profileId, c.dedupeKey),
        createdAt: opts.now.toISOString(),
        expiresAt: new Date(at + ttlDays * 86_400_000).toISOString(),
        ...(opts.push ? { push: "pending" as const } : {}),
      };
      inbox.items.unshift(stored);
      result.delivered.push(stored);
    }
    if (inbox.items.length > MAX_PER_PROFILE) inbox.items.length = MAX_PER_PROFILE;
    return result;
  });
}

/** Whether a profile already has (or deliberately skipped) this event. */
export function hasKey(inbox: ProfileInbox, dedupeKey: string): boolean {
  return inbox.keys[dedupeKey] !== undefined;
}

export function toView(n: StoredNotification): NotificationView {
  // Internal fields stay on the server.
  const { dedupeKey: _k, audience: _a, subject: _s, push: _p, certification: _c, ...view } = n;
  void _k;
  void _a;
  void _s;
  void _p;
  void _c;
  return view;
}

const visible = (n: StoredNotification, now: Date) => !n.dismissedAt && Date.parse(n.expiresAt) > now.getTime();

export function unreadCount(inbox: ProfileInbox, now = new Date()): number {
  return inbox.items.filter((n) => visible(n, now) && !n.readAt).length;
}

/**
 * Newest first. The cursor is the id of the last item of the previous page, so new notifications
 * arriving between requests never shift what the next page returns.
 */
export function listNotifications(
  dir: string,
  accountId: string,
  profileId: string,
  opts: { limit?: number; cursor?: string | null; unreadOnly?: boolean; now?: Date } = {}
): NotificationPage {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const inbox = readProfileInbox(dir, accountId, profileId);
  const all = inbox.items.filter((n) => visible(n, now) && (!opts.unreadOnly || !n.readAt));
  let start = 0;
  if (opts.cursor) {
    const at = all.findIndex((n) => n.id === opts.cursor);
    start = at >= 0 ? at + 1 : all.length;
  }
  const page = all.slice(start, start + limit);
  return {
    items: page.map(toView),
    unread: unreadCount(inbox, now),
    nextCursor: start + limit < all.length && page.length ? page[page.length - 1].id : null,
  };
}

export type NotificationAction = "read" | "unread" | "dismiss" | "read-all";

/**
 * Read/unread/dismiss for notifications of this profile only. Ids of other profiles simply do not
 * match, so one profile cannot change another's notifications. Returns how many changed.
 */
export function applyAction(dir: string, accountId: string, profileId: string, action: NotificationAction, ids: string[] = [], now = new Date()): number {
  const wanted = new Set(ids);
  return updateProfileInbox(dir, accountId, profileId, (inbox) => {
    let changed = 0;
    const stamp = now.toISOString();
    for (const n of inbox.items) {
      if (action !== "read-all" && !wanted.has(n.id)) continue;
      if (action === "read" || action === "read-all") {
        if (!n.readAt && !n.dismissedAt) {
          n.readAt = stamp;
          changed++;
        }
      } else if (action === "unread") {
        if (n.readAt) {
          delete n.readAt;
          changed++;
        }
      } else if (action === "dismiss" && !n.dismissedAt) {
        n.dismissedAt = stamp;
        n.readAt ??= stamp;
        // A dismissed suggestion is not suggested again.
        if (n.subject && (n.category === "trending" || n.category === "recommendations")) inbox.suppressed[n.subject] = now.getTime();
        for (const item of n.items ?? []) if (n.type === "digest") inbox.suppressed[`${item.mediaType}:${item.tmdbId}`] = now.getTime();
        changed++;
      }
    }
    return changed;
  });
}

// --- Follows -------------------------------------------------------------------------------------

export const seriesKey = (tmdbId: number) => `tv:${tmdbId}`;

export function setFollow(dir: string, accountId: string, profileId: string, tmdbId: number, follow: boolean, title?: string, now = new Date()): void {
  const key = seriesKey(tmdbId);
  updateProfileInbox(dir, accountId, profileId, (inbox) => {
    if (follow) {
      inbox.follows[key] = { at: now.getTime(), ...(title ? { title: title.slice(0, 200) } : {}) };
      delete inbox.muted[key];
    } else {
      delete inbox.follows[key];
      // Stays unfollowed even while the series is in My List or Continue Watching.
      inbox.muted[key] = now.getTime();
    }
  });
}

// --- Maintenance ---------------------------------------------------------------------------------

/** Removes expired notifications, old dedupe keys and stale counters; drops profiles that no longer exist. */
export function pruneInbox(dir: string, accountId: string, liveProfileIds: Set<string> | null, now = new Date()): { removed: number } {
  let removed = 0;
  updateInboxFile(dir, accountId, (data) => {
    for (const [profileId, inbox] of Object.entries(data.profiles)) {
      if (liveProfileIds && !liveProfileIds.has(profileId)) {
        delete data.profiles[profileId];
        continue;
      }
      const before = inbox.items.length;
      inbox.items = inbox.items.filter((n) => Date.parse(n.expiresAt) > now.getTime());
      removed += before - inbox.items.length;
      for (const [k, at] of Object.entries(inbox.keys)) if (now.getTime() - at > KEY_RETENTION_MS) delete inbox.keys[k];
      for (const [k, at] of Object.entries(inbox.suppressed)) if (now.getTime() - at > SUPPRESS_RETENTION_MS) delete inbox.suppressed[k];
      const day = utcDay(now);
      for (const [k, c] of Object.entries(inbox.counters)) if (c.day !== day) delete inbox.counters[k];
    }
  });
  return { removed };
}

export function listInboxAccounts(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "inbox"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => ID_RE.test(id));
  } catch {
    return [];
  }
}

export function removeInbox(dir: string, accountId: string): void {
  fs.rmSync(inboxFile(dir, accountId), { force: true });
}

// --- Push queue ----------------------------------------------------------------------------------

/** Notifications of every profile waiting for a browser push. */
export function pendingPushes(dir: string): Array<{ accountId: string; profileId: string; item: StoredNotification }> {
  const out: Array<{ accountId: string; profileId: string; item: StoredNotification }> = [];
  for (const accountId of listInboxAccounts(dir)) {
    for (const [profileId, inbox] of Object.entries(readInboxFile(dir, accountId).profiles)) {
      for (const item of inbox.items) if (item.push === "pending") out.push({ accountId, profileId, item });
    }
  }
  return out;
}

export function setPushState(dir: string, accountId: string, profileId: string, id: string, state: NonNullable<StoredNotification["push"]>): void {
  updateProfileInbox(dir, accountId, profileId, (inbox) => {
    const n = inbox.items.find((x) => x.id === id);
    if (n) n.push = state;
  });
}
