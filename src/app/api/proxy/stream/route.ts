import { NextRequest, NextResponse } from "next/server";
import { castCorsHeaders } from "@/lib/cast-cors";
import { resolveStreamSession } from "@/lib/stream-sessions";
import { debridProvider } from "@/lib/debrid";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: castCorsHeaders() });
}

export async function GET(request: NextRequest) {
  // Only registered stream sessions: an arbitrary ?url= would make this an open proxy.
  const session = request.nextUrl.searchParams.get("session");
  const url = session ? resolveStreamSession(session) : null;

  if (!url) {
    return NextResponse.json(
      { error: session ? "Stream session expired. Select the torrent again." : "Missing stream session" },
      { status: 400 }
    );
  }

  try {
    // Only the debrid provider's CDN: this relay is the engine-offline fallback for its files.
    if (url.startsWith("http:") || !debridProvider().isCdnUrl(url)) {
      return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
    }

    const range = request.headers.get("range");
    const headers: HeadersInit = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };
    if (range) headers["Range"] = range;

    const upstream = await fetch(url, { headers });
    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "video/mp4");
    responseHeaders.set("Accept-Ranges", "bytes");
    const contentLength = upstream.headers.get("Content-Length");
    const contentRange = upstream.headers.get("Content-Range");
    if (contentLength) responseHeaders.set("Content-Length", contentLength);
    if (contentRange) responseHeaders.set("Content-Range", contentRange);
    for (const [key, value] of Object.entries(castCorsHeaders())) {
      responseHeaders.set(key, value);
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
