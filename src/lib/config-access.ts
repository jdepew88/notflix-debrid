import "server-only";
import crypto from "crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getViewer, type Viewer } from "./auth";
import { hasOwner } from "./users";
import { cookieSecure } from "./session";
import { dataDir, sessionSecret, serverConfig } from "./install/runtime";
import { readSetupCode } from "./install/init.mjs";

/**
 * Who may read or change system configuration and credentials:
 *  - before an owner exists: whoever proved access to the server by entering the one-time setup
 *    code (written to the data folder and shown in the launcher window);
 *  - afterwards: the owner only (administrators manage accounts, not credentials).
 */
export const SETUP_COOKIE = "notflix_setup";
const SETUP_TTL_MS = 2 * 60 * 60 * 1000;

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Setup tokens are bound to the current setup code, so they die with it. */
function codeFingerprint(): string {
  const code = readSetupCode(dataDir()) ?? "";
  return crypto.createHash("sha256").update(code).digest("base64url").slice(0, 16);
}

export function createSetupToken(): string {
  const payload = `setup.${Date.now() + SETUP_TTL_MS}.${codeFingerprint()}`;
  return `${payload}.${sign(payload)}`;
}

export function validSetupToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "setup") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  if (parts[2] !== codeFingerprint() || !readSetupCode(dataDir())) return false;
  const expected = Buffer.from(sign(parts.slice(0, 3).join(".")));
  const got = Buffer.from(parts[3]);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export function setupCookie(token: string, request: NextRequest) {
  return {
    name: SETUP_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: cookieSecure(request),
    path: "/",
    maxAge: SETUP_TTL_MS / 1000,
  };
}

export function clearedSetupCookie(request: NextRequest) {
  return { ...setupCookie("", request), maxAge: 0 };
}

/** Constant-time comparison of a typed setup code (case/spacing insensitive). */
export function setupCodeMatches(input: unknown): boolean {
  const expected = readSetupCode(dataDir());
  if (!expected || typeof input !== "string") return false;
  const normalized = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = Buffer.from(normalized);
  const b = Buffer.from(expected.replace(/-/g, ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const forbidden = (error: string, code: string, status = 403) => NextResponse.json({ error, code }, { status });

export async function requireOwner(): Promise<Viewer | NextResponse> {
  const viewer = await getViewer();
  if (!viewer) return forbidden("Sign in required", "unauthenticated", 401);
  if (viewer.role !== "owner") {
    return forbidden("Only the server owner can view or change system settings and credentials.", "owner_only");
  }
  return viewer;
}

export type ConfigAccess = { kind: "owner"; viewer: Viewer } | { kind: "setup" };

/**
 * Access to installation settings: the setup-code holder before an owner exists, else the owner.
 * `allowBeforeOwner` limits which settings the setup-code holder may touch (server basics only).
 */
export async function requireConfigAccess(
  request: NextRequest,
  opts: { allowBeforeOwner?: boolean } = {}
): Promise<ConfigAccess | NextResponse> {
  if (!hasOwner()) {
    if (serverConfig().setup.completed) return forbidden("This server has no owner. Stop Notflix and run: scripts\\notflix.ps1 accounts claim-owner <username>", "no_owner");
    if (!opts.allowBeforeOwner) return forbidden("Create the owner account first.", "owner_required", 409);
    if (validSetupToken(request.cookies.get(SETUP_COOKIE)?.value)) return { kind: "setup" };
    return forbidden("Enter the setup code first.", "setup_code_required", 401);
  }
  const viewer = await requireOwner();
  if (viewer instanceof NextResponse) return viewer;
  return { kind: "owner", viewer };
}
