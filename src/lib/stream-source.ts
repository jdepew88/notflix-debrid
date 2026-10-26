import type { NextRequest } from "next/server";
import { resolveStreamSession } from "./stream-sessions";

export function resolveStreamInput(request: NextRequest): {
  url: string | null;
  path: string | null;
  error?: string;
} {
  const session = request.nextUrl.searchParams.get("session");
  const urlParam = request.nextUrl.searchParams.get("url");
  const path = request.nextUrl.searchParams.get("path");

  if (session) {
    const url = resolveStreamSession(session);
    if (!url) {
      return { url: null, path: null, error: "Stream session expired. Select the torrent again." };
    }
    return { url, path: null };
  }

  if (urlParam) return { url: null, path: null, error: "Direct URLs are not accepted; use a stream session." };
  if (path) return { url: null, path };
  return { url: null, path: null, error: "Missing url, session, or path" };
}

export async function resolveStreamBody(body: {
  session?: string;
  url?: string;
  path?: string;
}): Promise<{ url: string | null; path: string | null; error?: string }> {
  if (body.session) {
    const url = resolveStreamSession(body.session);
    if (!url) {
      return { url: null, path: null, error: "Stream session expired. Select the torrent again." };
    }
    return { url, path: null };
  }
  if (body.url) return { url: null, path: null, error: "Direct URLs are not accepted; use a stream session." };
  if (body.path) return { url: null, path: body.path };
  return { url: null, path: null, error: "Missing session, url, or path" };
}
