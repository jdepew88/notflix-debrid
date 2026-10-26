import { serverConfig } from "./install/runtime";

/**
 * In-memory attempt limiter for sign-in, sign-up and profile PINs. Counts events per key within a
 * window; state lives in this server process (fine for the single Notflix instance; a restart resets
 * it). Keys combine the client address with the account/profile, so one noisy client cannot lock
 * everyone out of an account and one account cannot be brute-forced from a single address.
 */
interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface LimitRule {
  max: number;
  windowMs: number;
}

export const LOGIN_PER_ACCOUNT: LimitRule = { max: 5, windowMs: 15 * 60_000 };
export const LOGIN_PER_ADDRESS: LimitRule = { max: 30, windowMs: 15 * 60_000 };
/** New accounts per address per hour; SIGNUP_RATE_LIMIT overrides it (the e2e test instance raises it). */
export const SIGNUP_PER_ADDRESS: LimitRule = {
  max: Math.max(1, parseInt(process.env.SIGNUP_RATE_LIMIT ?? "", 10) || 5),
  windowMs: 60 * 60_000,
};
export const PIN_PER_PROFILE: LimitRule = { max: 5, windowMs: 5 * 60_000 };
export const CLAIM_PER_ADDRESS: LimitRule = { max: 10, windowMs: 60 * 60_000 };

function prune(bucket: Bucket, rule: LimitRule, now: number) {
  while (bucket.hits.length && bucket.hits[0] <= now - rule.windowMs) bucket.hits.shift();
}

/** Seconds until another attempt is allowed, or 0 when the key is under its limit. */
export function retryAfter(key: string, rule: LimitRule, now = Date.now()): number {
  const bucket = buckets.get(key);
  if (!bucket) return 0;
  prune(bucket, rule, now);
  if (bucket.hits.length < rule.max) return 0;
  return Math.max(1, Math.ceil((bucket.hits[0] + rule.windowMs - now) / 1000));
}

export function recordHit(key: string, rule: LimitRule, now = Date.now()): void {
  const bucket = buckets.get(key) ?? { hits: [] };
  prune(bucket, rule, now);
  bucket.hits.push(now);
  buckets.set(key, bucket);
  if (buckets.size > 10_000) {
    // Bound memory: drop the oldest keys.
    for (const k of [...buckets.keys()].slice(0, 2_000)) buckets.delete(k);
  }
}

export function clearHits(key: string): void {
  buckets.delete(key);
}

/** Header the Notflix server (server.mjs) sets from the TCP connection; clients cannot supply it. */
export const PEER_HEADER = "x-notflix-peer";

/**
 * Client address for rate limiting and audit. Forwarded-for headers are only believed when the
 * owner said Notflix runs behind a reverse proxy; otherwise anyone could pick their own address.
 */
export function clientAddress(request: { headers: { get(name: string): string | null } }): string {
  const peer = request.headers.get(PEER_HEADER)?.trim();
  if (serverConfig().server.reverseProxy) {
    const forwarded =
      request.headers.get("cf-connecting-ip")?.trim() ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim();
    if (forwarded) return forwarded;
  }
  return peer || "local";
}

export function tooManyAttempts(seconds: number, what = "attempts") {
  const minutes = Math.ceil(seconds / 60);
  return {
    body: { error: `Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, code: "rate_limited", retryAfter: seconds },
    init: { status: 429, headers: { "Retry-After": String(seconds) } },
  };
}
