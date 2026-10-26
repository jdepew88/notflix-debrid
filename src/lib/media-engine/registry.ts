import "server-only";

/**
 * Engine sessions created by this Next.js process: engine session id → token + owner.
 * The token never leaves the server; the browser only knows the session id, and every proxied
 * request is checked against the signed-in user. Stored on globalThis so dev hot reloads keep it.
 */
export interface RegisteredSession {
  id: string;
  token: string;
  /** Notflix user id that owns the session. */
  owner: string;
  createdAt: number;
  lastSeen: number;
  title?: string;
  provider: string;
  /** Raw source so a session can be recreated after the engine restarts (never sent to clients). */
  sourceKey: string;
}

const globalKey = "__notflixEngineSessions";
type Store = Map<string, RegisteredSession>;
const g = globalThis as unknown as Record<string, Store | undefined>;
const sessions: Store = g[globalKey] ?? (g[globalKey] = new Map());

const MAX_AGE_MS = 13 * 60 * 60 * 1000;

export function registerSession(s: Omit<RegisteredSession, "createdAt" | "lastSeen">): void {
  prune();
  sessions.set(s.id, { ...s, createdAt: Date.now(), lastSeen: Date.now() });
}

export function getOwnedSession(id: string, userId: string): RegisteredSession | null {
  const s = sessions.get(id);
  if (!s || s.owner !== userId) return null;
  s.lastSeen = Date.now();
  return s;
}

export function forgetSession(id: string): void {
  sessions.delete(id);
}

export function sessionsForUser(userId: string): RegisteredSession[] {
  return [...sessions.values()].filter((s) => s.owner === userId);
}

function prune(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}
