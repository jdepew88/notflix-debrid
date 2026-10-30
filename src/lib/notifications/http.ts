import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { requireViewer, type Viewer } from "../auth";
import { serverConfig } from "../install/runtime";
import { clientAddress, recordHit, retryAfter, tooManyAttempts, type LimitRule } from "../rate-limit";
import type { UserProfile } from "../types";

export const ACTIONS_PER_USER: LimitRule = { max: 120, windowMs: 60_000 };
export const PUSH_CHANGES_PER_USER: LimitRule = { max: 20, windowMs: 60 * 60_000 };
export const RUN_JOBS_PER_USER: LimitRule = { max: 10, windowMs: 60 * 60_000 };

/**
 * Cross-site request forgery guard for state-changing requests. Session cookies are SameSite=Lax,
 * and these routes also require a JSON body; in addition the browser's own Sec-Fetch-Site / Origin
 * headers must say the request came from a Notflix page. Clients without those headers (apps,
 * scripts) do not send cookies automatically, so they cannot be abused this way.
 */
export function crossSiteRefusal(request: NextRequest): NextResponse | null {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
    }
    const hosts = [request.headers.get("host")];
    if (serverConfig().server.reverseProxy) hosts.push(request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? null);
    if (!hosts.some((h) => h && h.toLowerCase() === originHost)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Send JSON" }, { status: 415 });
  }
  return null;
}

export type ProfileViewer = Viewer & { profile: UserProfile };

/** Signed in and a profile chosen in this browser (notifications are per profile). */
export async function requireProfileViewer(): Promise<ProfileViewer | NextResponse> {
  const viewer = await requireViewer();
  if (viewer instanceof NextResponse) return viewer;
  if (!viewer.profile) return NextResponse.json({ error: "Choose a profile first.", code: "no_profile" }, { status: 409 });
  return viewer as ProfileViewer;
}

/** Counts one request against a per-user limit; returns a 429 response when over it. */
export function limited(request: NextRequest, userId: string, name: string, rule: LimitRule): NextResponse | null {
  const key = `notify:${name}:${userId}:${clientAddress(request)}`;
  const wait = retryAfter(key, rule);
  if (wait > 0) {
    const r = tooManyAttempts(wait, "requests");
    return NextResponse.json(r.body, r.init);
  }
  recordHit(key, rule);
  return null;
}
