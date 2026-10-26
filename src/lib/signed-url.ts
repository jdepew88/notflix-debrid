/**
 * Short-lived signed media URLs ("capability" links) for clients that cannot send the session
 * cookie, e.g. a Chromecast receiver. Works in both the proxy and route handlers (Web Crypto).
 */
import { sessionSecret } from "./install/runtime";

const enc = new TextEncoder();

/** Per-installation random key (generated on first start; never a built-in default). */
function secret(): string {
  return sessionSecret();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical form: path + sorted query params excluding the signature itself. */
function canonical(pathname: string, params: URLSearchParams): string {
  const entries = [...params.entries()].filter(([k]) => k !== "ct").sort(([a], [b]) => a.localeCompare(b));
  return `${pathname}?${entries.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`signed-url:${secret()}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

/** Signs a same-origin path (e.g. "/api/playback/abc/manifest"). Returns the path with `ct` added. */
export async function signMediaPath(pathWithQuery: string, ttlSeconds = 6 * 60 * 60, userId = ""): Promise<string> {
  const url = new URL(pathWithQuery, "http://local");
  url.searchParams.delete("ct");
  url.searchParams.set("cu", userId);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  url.searchParams.set("cx", String(exp));
  const sig = await hmac(canonical(url.pathname, url.searchParams));
  url.searchParams.set("ct", sig);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

/** Verifies a signed URL. Returns the user id it was issued to, or null. */
export async function verifySignedMediaUrl(pathname: string, params: URLSearchParams): Promise<string | null> {
  const sig = params.get("ct");
  const exp = Number(params.get("cx"));
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  const expected = await hmac(canonical(pathname, params));
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? params.get("cu") ?? "" : null;
}
