import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDataPath } from "./data-path";
import {
  PROFILE_COOKIE,
  SESSION_COOKIE,
  clearedSessionCookie,
  createSessionToken,
  parseProfileToken,
  parseSessionToken,
  sessionCookieOptions,
} from "./session";
import { getUserById, isAdminRole, readUserState, roleOf, type AccountRole, type UserAccount, type UserState } from "./users";
import { profileMaturity, strictestLevel, type MaturityLevel } from "./maturity";
import type { UserProfile } from "./types";

export { SESSION_COOKIE, clearedSessionCookie, createSessionToken, parseSessionToken, sessionCookieOptions };

/**
 * scrypt with OWASP's recommended cost (N=2^17, r=8, p=1: ~128 MiB, a few hundred ms). Hashes are
 * self-describing (`scrypt$N,r,p$salt$hash`) so parameters can be raised later; the original
 * `salt:hash` format (N=2^14) still verifies. Runs on the libuv thread pool, never blocking the
 * event loop that relays video.
 */
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;

function scrypt(password: string, salt: Buffer | string, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

const maxmem = (N: number, r: number) => 256 * N * r + 32 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, { N, r, p, maxmem: maxmem(N, r) });
  return `scrypt$${N},${r},${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (stored.startsWith("scrypt$")) {
      const [, params, saltB64, hashB64] = stored.split("$");
      const [N, r, p] = params.split(",").map(Number);
      if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 32 || p > 16) return false;
      const expected = Buffer.from(hashB64, "base64url");
      const test = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, { N, r, p, maxmem: maxmem(N, r) });
      return expected.length > 0 && timingSafeEqual(expected, test);
    }
    // Legacy format from earlier builds: hex salt (used as a string) and a 64-byte hex hash.
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const test = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return expected.length === test.length && timingSafeEqual(expected, test);
  } catch {
    return false;
  }
}

/** Whether a stored hash uses weaker parameters than today's and should be re-hashed on sign-in. */
export function needsRehash(stored: string): boolean {
  if (!stored.startsWith("scrypt$")) return true;
  const [N, r, p] = stored.split("$")[1].split(",").map(Number);
  return N < SCRYPT_PARAMS.N || r < SCRYPT_PARAMS.r || p < SCRYPT_PARAMS.p;
}

/** The signed-in account, if its session token is valid and still current (not revoked by a password change). */
async function sessionAccount(): Promise<UserAccount | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const parsed = await parseSessionToken(token);
  if (!parsed) return null;
  const user = getUserById(parsed.userId);
  if (!user || (user.sessionVersion ?? 0) !== parsed.version) return null;
  return user;
}

export async function getSessionUserId(): Promise<string | null> {
  return (await sessionAccount())?.id ?? null;
}

/** Session user that still exists in the account store (a valid signature alone is not enough). */
export async function getSessionUser(): Promise<{ id: string; name: string; role: AccountRole } | null> {
  const user = await sessionAccount();
  return user ? { id: user.id, name: user.name, role: roleOf(user) } : null;
}

export interface Viewer {
  user: UserAccount;
  role: AccountRole;
  state: UserState;
  /** The profile this browser selected (server-verified via the signed profile cookie), if any. */
  profile: UserProfile | null;
  /**
   * Maturity level that applies to this request. Without a selected profile the strictest level of
   * the account's profiles applies, so clearing the profile cookie cannot widen what a kid sees.
   */
  maturity: MaturityLevel;
}

export async function getViewer(): Promise<Viewer | null> {
  const user = await sessionAccount();
  if (!user) return null;
  const state = readUserState(user.id);
  const cookieStore = await cookies();
  const token = cookieStore.get(PROFILE_COOKIE)?.value;
  const profileId = token ? await parseProfileToken(token, user.id) : null;
  const profile = profileId ? state.profiles.find((p) => p.id === profileId) ?? null : null;
  const maturity = profile ? profileMaturity(profile) : strictestLevel(state.profiles.map(profileMaturity));
  return { user, role: roleOf(user), state, profile, maturity };
}

const UNAUTHORIZED = () => NextResponse.json({ error: "Sign in required" }, { status: 401 });

/** For route handlers: `const v = await requireViewer(); if (v instanceof NextResponse) return v;` */
export async function requireViewer(): Promise<Viewer | NextResponse> {
  return (await getViewer()) ?? UNAUTHORIZED();
}

/** Owner or administrator only (server settings, provider credentials, engine configuration). */
export async function requireAdmin(): Promise<Viewer | NextResponse> {
  const viewer = await getViewer();
  if (!viewer) return UNAUTHORIZED();
  if (!isAdminRole(viewer.role)) {
    return NextResponse.json(
      { error: "Only the server owner or an administrator can change server settings.", code: "forbidden" },
      { status: 403 }
    );
  }
  return viewer;
}

export function usersFilePath(): string {
  return `${getDataPath()}/users.json`;
}

/**
 * Legacy playback routes (pre-engine) cannot check a title's rating, so restricted profiles may not
 * use them; the current player goes through /api/playback/start, which does check.
 */
export async function refuseRestrictedProfile(): Promise<NextResponse | null> {
  const viewer = await getViewer();
  if (!viewer || viewer.maturity === "all") return null;
  return NextResponse.json({ error: "This isn't available on this profile.", code: "maturity_restricted" }, { status: 403 });
}
