import { sessionSecret as installSessionSecret } from "./install/runtime";

export const SESSION_COOKIE = "notflix_session";
/** Signed "which profile is this browser using" cookie; the server's view of the active profile. */
export const PROFILE_COOKIE = "notflix_profile";
/** "Remember me": a persistent cookie for 30 days. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** Without "Remember me": a browser-session cookie whose token still expires after 12 hours. */
export const SHORT_SESSION_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

/** Random per-installation key generated on first start (never a built-in default). */
function sessionSecret(): string {
  return installSessionSecret();
}

type RequestLike = { headers: { get(name: string): string | null }; nextUrl?: { protocol: string } };

/**
 * Whether the session cookie gets the Secure flag.
 * COOKIE_SECURE=true|false forces it; unset or "auto" decides per request so the same server works on
 * http://localhost:<port>, a LAN address and behind an HTTPS reverse proxy (which sets
 * X-Forwarded-Proto). Only a request the browser made over HTTPS gets a Secure cookie, so plain-HTTP
 * LAN logins are never silently dropped.
 */
export function cookieSecure(request?: RequestLike): boolean {
  const explicit = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  if (!request) return false;
  return requestIsHttps(request);
}

export function requestIsHttps(request: RequestLike): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  const cfVisitor = request.headers.get("cf-visitor");
  if (cfVisitor?.includes('"https"')) return true;
  return request.nextUrl?.protocol === "https:";
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(sig);
}

/**
 * Session token: `userId.exp.version.sig`. `version` is the account's session version; changing a
 * password bumps it, which signs out every other browser. Tokens issued before versions existed
 * (`userId.exp.sig`) still parse, as version 0.
 */
export async function createSessionToken(
  userId: string,
  opts: { version?: number; remember?: boolean } = {}
): Promise<string> {
  const exp = Date.now() + (opts.remember === false ? SHORT_SESSION_MS : SESSION_MS);
  const payload = `${userId}.${exp}.${opts.version ?? 0}`;
  const sig = await hmacHex(payload);
  return `${payload}.${sig}`;
}

export async function parseSessionToken(
  token: string
): Promise<{ userId: string; version: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [userId, expStr] = parts;
  const versionStr = parts.length === 4 ? parts[2] : null;
  const sig = parts[parts.length - 1];
  const exp = parseInt(expStr, 10);
  const version = versionStr === null ? 0 : parseInt(versionStr, 10);
  if (!userId || !Number.isFinite(exp) || exp < Date.now() || !Number.isInteger(version) || version < 0) return null;
  const payload = versionStr === null ? `${userId}.${expStr}` : `${userId}.${expStr}.${versionStr}`;
  const expected = await hmacHex(payload);
  if (!safeEqual(sig, expected)) return null;
  return { userId, version };
}

/** `remember: false` gives a browser-session cookie (no Max-Age); the token itself expires in 12 h. */
export function sessionCookieOptions(token: string, request?: RequestLike, opts: { remember?: boolean } = {}) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: cookieSecure(request),
    path: "/",
    ...(opts.remember === false ? {} : { maxAge: SESSION_MS / 1000 }),
  };
}

/** Expired cookie that removes the session (used on logout and when the account no longer exists). */
export function clearedSessionCookie(request?: RequestLike) {
  return { ...sessionCookieOptions("", request), maxAge: 0 };
}

/** Profile token: `userId.profileId.exp.sig` — bound to the account so it cannot be reused by another. */
export async function createProfileToken(userId: string, profileId: string): Promise<string> {
  const payload = `p.${userId}.${profileId}.${Date.now() + SESSION_MS}`;
  return `${payload}.${await hmacHex(payload)}`;
}

export async function parseProfileToken(token: string, userId: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "p" || parts[1] !== userId) return null;
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const payload = parts.slice(0, 4).join(".");
  if (!safeEqual(parts[4], await hmacHex(payload))) return null;
  return parts[2];
}

export function profileCookieOptions(token: string, request?: RequestLike) {
  return { ...sessionCookieOptions(token, request), name: PROFILE_COOKIE };
}

export function clearedProfileCookie(request?: RequestLike) {
  return { ...profileCookieOptions("", request), maxAge: 0 };
}
