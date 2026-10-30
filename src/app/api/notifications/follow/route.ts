import { NextRequest, NextResponse } from "next/server";
import { readProfileInbox, seriesKey, setFollow } from "@/lib/notifications/store";
import { notificationsDir } from "@/lib/notifications/server";
import { ACTIONS_PER_USER, crossSiteRefusal, limited, requireProfileViewer } from "@/lib/notifications/http";

export const dynamic = "force-dynamic";

const validId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e9;

/**
 * Whether the profile in use follows a series for episode/season notifications, and why:
 * explicitly, through My List, or by watching it recently. `muted` = explicitly unfollowed.
 */
export async function GET(request: NextRequest) {
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const tmdbId = Number(request.nextUrl.searchParams.get("tmdbId"));
  if (!validId(tmdbId)) return NextResponse.json({ error: "tmdbId required" }, { status: 400 });
  const inbox = readProfileInbox(notificationsDir(), viewer.user.id, viewer.profile.id);
  const key = seriesKey(tmdbId);
  const inList = (viewer.state.myListByProfile[viewer.profile.id] ?? []).includes(`tmdb-tv-${tmdbId}`);
  const watching = Boolean(viewer.state.lastWatchedByProfile?.[viewer.profile.id]?.[`tmdb-tv-${tmdbId}`]);
  const muted = inbox.muted[key] !== undefined && !inbox.follows[key];
  const source = inbox.follows[key] ? "explicit" : inList ? "my-list" : watching ? "watching" : null;
  return NextResponse.json({ following: Boolean(source) && !muted, source, muted });
}

/** { tmdbId, follow: boolean, title? } */
export async function POST(request: NextRequest) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const tooMany = limited(request, viewer.user.id, "follow", ACTIONS_PER_USER);
  if (tooMany) return tooMany;
  const body = (await request.json().catch(() => ({}))) as { tmdbId?: unknown; follow?: unknown; title?: unknown };
  if (!validId(body.tmdbId) || typeof body.follow !== "boolean") return NextResponse.json({ error: "tmdbId and follow required" }, { status: 400 });
  const title = typeof body.title === "string" ? body.title.replace(/[<>]/g, "").slice(0, 200) : undefined;
  setFollow(notificationsDir(), viewer.user.id, viewer.profile.id, body.tmdbId, body.follow, title);
  return NextResponse.json({ following: body.follow });
}
