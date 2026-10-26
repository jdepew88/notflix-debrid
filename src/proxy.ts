import { NextResponse } from "next/server";
import { SESSION_COOKIE, parseSessionToken } from "@/lib/session";
import { verifySignedMediaUrl } from "@/lib/signed-url";
import { serverConfig } from "@/lib/install/runtime";
import type { NextRequest } from "next/server";

const AUTH_ENTRY_PATHS = ["/", "/signup", "/login"];
const PROTECTED_PAGES = ["/browse", "/watch", "/profiles", "/settings"];
const SETUP_PAGE = "/setup";

/**
 * API routes reachable without a session cookie. Everything else under /api requires sign-in.
 * /api/setup/* and /api/config/* do their own authorization (setup code or owner session).
 */
const PUBLIC_API = ["/api/auth/", "/api/health", "/api/setup/", "/api/config/"];

/**
 * Media routes that may also be opened with a signed capability link (`ct`), for receivers such as
 * Chromecast that cannot send cookies. /api/proxy/stream additionally accepts its random stream
 * session id, which is itself an unguessable capability.
 */
const SIGNED_MEDIA_PREFIXES = ["/api/playback/", "/api/proxy/stream"];

/** Set by server.mjs from the TCP connection (any client-supplied value is overwritten). */
const PEER_HEADER = "x-notflix-peer";

function isLoopback(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "");
  return a === "::1" || a.startsWith("127.");
}

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const cfg = serverConfig();

  // Defense in depth: without LAN access the server binds to loopback, but refuse remote peers
  // here too in case it was started on another interface.
  const peer = request.headers.get(PEER_HEADER);
  if (!cfg.server.allowLan && peer && !isLoopback(peer)) {
    return new NextResponse("This Notflix server only accepts connections from the computer it runs on.", { status: 403 });
  }

  if (pathname.startsWith("/api/")) {
    if (PUBLIC_API.some((p) => pathname.startsWith(p))) return NextResponse.next();
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const session = token ? await parseSessionToken(token) : null;
    if (session) return NextResponse.next();

    if (SIGNED_MEDIA_PREFIXES.some((p) => pathname.startsWith(p))) {
      if (searchParams.has("ct") && (await verifySignedMediaUrl(pathname, searchParams)) !== null) {
        return NextResponse.next();
      }
      if (pathname === "/api/proxy/stream" && /^[a-f0-9]{20}$/.test(searchParams.get("session") ?? "")) {
        return NextResponse.next();
      }
    }
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  // First run: every page leads to the setup wizard until setup is complete.
  if (!cfg.setup.completed) {
    if (pathname === SETUP_PAGE) return NextResponse.next();
    return NextResponse.redirect(new URL(SETUP_PAGE, request.url));
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await parseSessionToken(token) : null;
  const isAuthed = !!session;

  if (pathname === SETUP_PAGE) {
    // Setup is finished: the wizard cannot be restarted. The owner changes things in Settings.
    return NextResponse.redirect(new URL(isAuthed ? "/settings" : "/", request.url));
  }

  if (AUTH_ENTRY_PATHS.includes(pathname)) {
    if (isAuthed) {
      const next = searchParams.get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/profiles";
      return NextResponse.redirect(new URL(target, request.url));
    }
    return NextResponse.next();
  }

  if (PROTECTED_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!isAuthed) {
      const login = new URL("/", request.url);
      login.searchParams.set("next", pathname + request.nextUrl.search);
      return NextResponse.redirect(login);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/login",
    "/signup",
    "/setup",
    "/profiles",
    "/browse/:path*",
    "/watch/:path*",
    "/settings/:path*",
    "/settings",
    "/api/:path*",
  ],
};
