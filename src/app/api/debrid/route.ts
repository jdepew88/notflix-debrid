import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/config-access";
import {
  getDebridUser,
  addMagnet,
  listTorrents,
  getTorrentInfo,
  resolveTorrentStream,
  deleteTorrent,
} from "@/lib/real-debrid-api";
import { secrets } from "@/lib/install/runtime";
import { registerStreamUrlIfLong } from "@/lib/stream-sessions";

/** Server-stored token only; browsers never hold the Real-Debrid token. */
function getToken(_request: NextRequest): string | null {
  return secrets().realDebridToken || null;
}

export async function GET(request: NextRequest) {
  const admin = await requireOwner();
  if (admin instanceof NextResponse) return admin;
  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ error: "Real-Debrid token required" }, { status: 401 });
  }

  const action = request.nextUrl.searchParams.get("action");

  try {
    if (action === "torrents") {
      const torrents = await listTorrents(token);
      return NextResponse.json({ torrents });
    }

    const user = await getDebridUser(token);
    return NextResponse.json({ user });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Debrid API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireOwner();
  if (admin instanceof NextResponse) return admin;
  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ error: "Real-Debrid token required" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { action, magnet, torrentId } = body;

    if (action === "addMagnet" && magnet) {
      const result = await addMagnet(token, magnet);
      return NextResponse.json(result);
    }

    if (action === "resolve" && torrentId) {
      const season =
        typeof body.season === "number"
          ? body.season
          : typeof body.season === "string"
            ? parseInt(body.season, 10)
            : undefined;
      const episode =
        typeof body.episode === "number"
          ? body.episode
          : typeof body.episode === "string"
            ? parseInt(body.episode, 10)
            : undefined;
      const stream = await resolveTorrentStream(
        token,
        torrentId,
        Number.isFinite(season) ? season : undefined,
        Number.isFinite(episode) ? episode : undefined
      );
      const { session, proxyPath } = registerStreamUrlIfLong(stream.streamUrl);
      return NextResponse.json({
        ...stream,
        streamUrl: proxyPath,
        streamSession: session,
      });
    }

    if (action === "info" && torrentId) {
      const info = await getTorrentInfo(token, torrentId);
      return NextResponse.json(info);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Debrid API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requireOwner();
  if (admin instanceof NextResponse) return admin;
  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ error: "Real-Debrid token required" }, { status: 401 });
  }

  const torrentId = request.nextUrl.searchParams.get("id");
  if (!torrentId) {
    return NextResponse.json({ error: "Missing torrent id" }, { status: 400 });
  }

  try {
    await deleteTorrent(token, torrentId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
