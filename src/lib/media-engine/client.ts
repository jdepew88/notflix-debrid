import "server-only";
import crypto from "crypto";
import { dataDir, engineSecret as installEngineSecret } from "../install/runtime";
import { readEngineConfig } from "../install/config.mjs";

/**
 * Server-side client for the media engine (services/media-engine).
 * The engine listens on loopback only; the browser never talks to it directly. Next.js mints a
 * short-lived signed ticket for every playback session and proxies media through
 * /api/playback/{id}/..., checking the viewer's session cookie on every request.
 */

export interface TicketSource {
  kind: "url" | "file";
  url?: string;
  path?: string;
  provider: "real-debrid" | "sample";
  fileName?: string;
  fileSize?: number;
  title?: string;
}

/** Loopback address of the engine (its port comes from `<data>/config/engine.json`). */
export function engineUrl(): string {
  const override = process.env.MEDIA_ENGINE_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  return `http://127.0.0.1:${readEngineConfig(dataDir()).port}`;
}

function engineSecret(): string {
  const secret = installEngineSecret();
  if (secret.length < 32) {
    throw new EngineUnavailableError("The media engine key has not been generated yet", "not-configured");
  }
  return secret;
}

export function engineConfigured(): boolean {
  return installEngineSecret().length >= 32;
}

export class EngineUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: "not-configured" | "unreachable" | "timeout"
  ) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

export class EngineRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "EngineRequestError";
  }
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/** Ticket = base64url(json) "." base64url(HMAC-SHA256). Single use, 60 s lifetime. */
export function mintTicket(source: TicketSource, owner: string, ttlSeconds = 60): string {
  const payload = {
    v: 1,
    owner,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(16).toString("hex"),
    src: source,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", engineSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export interface EngineSessionAuth {
  token: string;
  owner: string;
}

export async function engineFetch(
  path: string,
  init: RequestInit & { session?: EngineSessionAuth; timeoutMs?: number } = {}
): Promise<Response> {
  const { session, timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("X-Engine-Key", engineSecret());
  if (session) {
    headers.set("X-Session-Token", session.token);
    headers.set("X-Owner", session.owner);
  }
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const signal = rest.signal ? AbortSignal.any([rest.signal, controller.signal]) : controller.signal;
  try {
    return await fetch(`${engineUrl()}${path}`, { ...rest, headers, signal, cache: "no-store" });
  } catch (err) {
    if (controller.signal.aborted && !rest.signal?.aborted) {
      throw new EngineUnavailableError("The media engine did not respond in time", "timeout");
    }
    if (rest.signal?.aborted) throw err;
    throw new EngineUnavailableError("The media engine is not running", "unreachable");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function engineJson<T>(
  path: string,
  init: RequestInit & { session?: EngineSessionAuth; timeoutMs?: number } = {}
): Promise<T> {
  const res = await engineFetch(path, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; detail?: string };
    throw new EngineRequestError(d.error || `Media engine error ${res.status}`, res.status, d.code, d.detail);
  }
  return data as T;
}

export interface EngineHealth {
  online: boolean;
  version?: string;
  reason?: string;
}

export async function engineHealth(): Promise<EngineHealth> {
  if (!engineConfigured()) return { online: false, reason: "not-configured" };
  try {
    const res = await fetch(`${engineUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { online: false, reason: `http-${res.status}` };
    const data = (await res.json()) as { version?: string };
    return { online: true, version: data.version };
  } catch {
    return { online: false, reason: "unreachable" };
  }
}

export async function pushEngineRuntimeConfig(config: {
  maxConcurrentVideoTranscodes?: number;
  maxTranscodeHeight?: number;
  hardwareAcceleration?: string;
  hardwareDevice?: string | null;
  cacheMaxBytes?: number;
}): Promise<boolean> {
  if (!engineConfigured()) return false;
  try {
    await engineJson("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      timeoutMs: 2000,
    });
    return true;
  } catch {
    return false;
  }
}
