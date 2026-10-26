import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { EngineUnavailableError, engineFetch } from "@/lib/media-engine/client";
import { forgetSession, getOwnedSession } from "@/lib/media-engine/registry";
import { signMediaPath, verifySignedMediaUrl } from "@/lib/signed-url";

export const dynamic = "force-dynamic";

/**
 * Authenticated relay between the browser and the private media engine (loopback only).
 * - checks the Notflix session cookie (or a signed cast link) and that the engine session belongs
 *   to that user; the engine session token never leaves the server;
 * - streams bodies straight through (no buffering), forwards Range for direct play, and cancels the
 *   engine request when the browser disconnects.
 */
const ALLOWED = [
  /^manifest$/,
  /^segments\/\d{1,6}\/(init\.mp4|seg_\d{5}\.m4s)$/,
  /^stream$/,
  /^status$/,
  /^metrics$/,
  /^subtitles\/\d{1,3}$/,
  /^seek$/,
  /^tracks$/,
];

const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
  "x-generation",
  "x-generation-start",
  "x-subtitle-complete",
  "x-subtitle-failed",
  "x-source-start-time",
];

type Params = { params: Promise<{ id: string; path: string[] }> };

async function authorize(request: NextRequest, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  let userId = await getSessionUserId();
  let signed = false;
  if (!userId) {
    userId = await verifySignedMediaUrl(request.nextUrl.pathname, request.nextUrl.searchParams);
    signed = userId !== null;
  }
  if (!userId) return null;
  const session = getOwnedSession(id, userId);
  return session ? { session, signed, userId } : null;
}

async function relay(request: NextRequest, { params }: Params, method: "GET" | "POST") {
  const { id, path } = await params;
  const sub = (path ?? []).join("/");
  if (!ALLOWED.some((re) => re.test(sub))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const auth = await authorize(request, id);
  if (!auth) return NextResponse.json({ error: "Playback session not found", code: "session-gone" }, { status: 404 });

  const query = new URLSearchParams(request.nextUrl.searchParams);
  for (const k of ["ct", "cu", "cx"]) query.delete(k);
  const qs = query.toString();
  const headers: HeadersInit = {};
  const range = request.headers.get("range");
  if (range) (headers as Record<string, string>)["Range"] = range;
  if (method === "POST") (headers as Record<string, string>)["Content-Type"] = "application/json";

  let upstream: Response;
  try {
    upstream = await engineFetch(`/sessions/${id}/${sub}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
      body: method === "POST" ? await request.text() : undefined,
      session: { token: auth.session.token, owner: auth.session.owner },
      signal: request.signal,
      timeoutMs: sub.startsWith("segments") || sub === "manifest" ? 60_000 : sub === "stream" ? undefined : 95_000,
    });
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      return NextResponse.json({ error: "The media engine is offline.", code: "engine-offline" }, { status: 503 });
    }
    return new NextResponse(null, { status: 499 });
  }

  if (upstream.status === 404 && sub === "status") forgetSession(id);

  const out = new Headers();
  for (const name of PASS_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  out.set("Cache-Control", "no-store");
  out.set("X-Accel-Buffering", "no");

  // Signed (cast) manifests: segment URIs must carry their own signatures.
  if (sub === "manifest" && auth.signed && upstream.ok) {
    const text = await upstream.text();
    const base = `/api/playback/${id}/`;
    const lines = await Promise.all(
      text.split("\n").map(async (line) => {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (uri) return line.replace(uri, await signMediaPath(base + uri, 6 * 60 * 60, auth.userId));
        if (line && !line.startsWith("#")) return signMediaPath(base + line, 6 * 60 * 60, auth.userId);
        return line;
      })
    );
    out.delete("content-length");
    return new NextResponse(lines.join("\n"), { status: 200, headers: out });
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}

export function GET(request: NextRequest, ctx: Params) {
  return relay(request, ctx, "GET");
}

export function POST(request: NextRequest, ctx: Params) {
  return relay(request, ctx, "POST");
}
