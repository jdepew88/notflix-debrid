/**
 * Browser push subscriptions (<data>/db/notifications/push.json, owner-only data folder). Each one
 * belongs to one account and profile; it is replaced when the same browser registers for another
 * profile, and removed when the push service reports it gone, after repeated failures, or when the
 * browser unsubscribes.
 *
 * The server sends encrypted messages to the subscription's endpoint URL, which the browser chose.
 * To keep a signed-in user from making the server contact arbitrary hosts (SSRF), endpoints must be
 * HTTPS URLs of a known browser push service. NOTFLIX_PUSH_HOSTS adds more host suffixes.
 */
import crypto from "node:crypto";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../install/store.mjs";

export interface PushSubscriptionRecord {
  id: string;
  accountId: string;
  profileId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt?: string;
  failures: number;
  /**
   * The account's session version when the browser registered. A password change or reset signs the
   * account out everywhere and bumps it; subscriptions from before are then dropped.
   */
  sessionVersion?: number;
  /** Short browser label for the settings list ("Chrome on Windows"). */
  label?: string;
}

interface PushFile {
  version: number;
  subscriptions: PushSubscriptionRecord[];
}

export const MAX_PER_PROFILE = 5;
export const MAX_PER_ACCOUNT = 20;
/** Consecutive failed deliveries before a subscription is dropped. */
export const MAX_FAILURES = 5;

/** Push services of Chrome/Edge/Opera (FCM), Firefox, Safari and Windows. */
const DEFAULT_PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function allowedPushHosts(): string[] {
  const extra = (process.env.NOTFLIX_PUSH_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h));
  return [...DEFAULT_PUSH_HOSTS, ...extra];
}

/** Returns an error message, or null when the endpoint is acceptable. */
export function checkEndpoint(endpoint: unknown, hosts = allowedPushHosts()): string | null {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return "Invalid push endpoint";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "Invalid push endpoint";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "Push endpoints must be HTTPS";
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return "This browser's push service is not supported";
  return null;
}

const B64U = /^[A-Za-z0-9_-]+={0,2}$/;

export function checkKeys(keys: unknown): { p256dh: string; auth: string } | null {
  const k = (keys && typeof keys === "object" ? keys : {}) as Record<string, unknown>;
  if (typeof k.p256dh !== "string" || typeof k.auth !== "string") return null;
  if (!B64U.test(k.p256dh) || !B64U.test(k.auth) || k.p256dh.length > 200 || k.auth.length > 64) return null;
  const pub = Buffer.from(k.p256dh, "base64url");
  if (pub.length !== 65 || pub[0] !== 4 || Buffer.from(k.auth, "base64url").length < 16) return null;
  return { p256dh: k.p256dh.replace(/=+$/, ""), auth: k.auth.replace(/=+$/, "") };
}

const file = (dir: string) => path.join(dir, "push.json");

function read(dir: string): PushFile {
  const raw = readJson(file(dir), null) as PushFile | null;
  return { version: 1, subscriptions: Array.isArray(raw?.subscriptions) ? raw!.subscriptions.filter((s) => s && typeof s.endpoint === "string") : [] };
}

function update<T>(dir: string, fn: (data: PushFile) => T): T {
  return withFileLock(`${file(dir)}.lock`, () => {
    const data = read(dir);
    const result = fn(data);
    writeJsonAtomic(file(dir), data);
    return result;
  });
}

export function listSubscriptions(dir: string, filter?: { accountId?: string; profileId?: string }): PushSubscriptionRecord[] {
  return read(dir).subscriptions.filter((s) => (!filter?.accountId || s.accountId === filter.accountId) && (!filter?.profileId || s.profileId === filter.profileId));
}

/**
 * Registers (or moves) a browser's subscription to this account and profile. The endpoint is the
 * browser's identity: registering it again replaces the old record, whoever owned it, because only
 * the browser that holds the subscription can present it.
 */
export function saveSubscription(
  dir: string,
  input: { accountId: string; profileId: string; endpoint: string; p256dh: string; auth: string; label?: string; sessionVersion?: number },
  now = new Date()
): PushSubscriptionRecord {
  return update(dir, (data) => {
    data.subscriptions = data.subscriptions.filter((s) => s.endpoint !== input.endpoint);
    const mine = data.subscriptions.filter((s) => s.accountId === input.accountId);
    if (mine.filter((s) => s.profileId === input.profileId).length >= MAX_PER_PROFILE || mine.length >= MAX_PER_ACCOUNT) {
      // Drop the oldest of this profile (or account) instead of refusing a fresh browser.
      const pool = mine.filter((s) => s.profileId === input.profileId).length >= MAX_PER_PROFILE ? mine.filter((s) => s.profileId === input.profileId) : mine;
      const oldest = [...pool].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      data.subscriptions = data.subscriptions.filter((s) => s !== oldest);
    }
    const record: PushSubscriptionRecord = {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      profileId: input.profileId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      failures: 0,
      sessionVersion: input.sessionVersion ?? 0,
      ...(input.label ? { label: input.label.slice(0, 60) } : {}),
    };
    data.subscriptions.push(record);
    return record;
  });
}

/** Removes a subscription, only if it belongs to this account. Returns whether one was removed. */
export function removeSubscription(dir: string, accountId: string, endpoint: string): boolean {
  return update(dir, (data) => {
    const before = data.subscriptions.length;
    data.subscriptions = data.subscriptions.filter((s) => !(s.endpoint === endpoint && s.accountId === accountId));
    return data.subscriptions.length < before;
  });
}

export function removeSubscriptionsWhere(dir: string, match: (s: PushSubscriptionRecord) => boolean): number {
  return update(dir, (data) => {
    const before = data.subscriptions.length;
    data.subscriptions = data.subscriptions.filter((s) => !match(s));
    return before - data.subscriptions.length;
  });
}

/** Records a delivery result; drops subscriptions that are gone or keep failing. */
export function recordDelivery(dir: string, id: string, result: { ok: boolean; gone: boolean }, now = new Date()): void {
  update(dir, (data) => {
    const s = data.subscriptions.find((x) => x.id === id);
    if (!s) return;
    if (result.ok) {
      s.failures = 0;
      s.lastSuccessAt = now.toISOString();
    } else s.failures++;
    if (result.gone || s.failures >= MAX_FAILURES) data.subscriptions = data.subscriptions.filter((x) => x.id !== id);
  });
}
