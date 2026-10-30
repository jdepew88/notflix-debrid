import { NextRequest, NextResponse } from "next/server";
import { applyAction, listNotifications, readProfileInbox, unreadCount, type NotificationAction } from "@/lib/notifications/store";
import { notificationsDir } from "@/lib/notifications/server";
import { ACTIONS_PER_USER, crossSiteRefusal, limited, requireProfileViewer } from "@/lib/notifications/http";

export const dynamic = "force-dynamic";

/**
 * The notification center of the profile in use (signed profile cookie): newest first, paginated
 * with an opaque cursor. `?count=1` returns only the unread count (the bell's badge).
 */
export async function GET(request: NextRequest) {
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const q = request.nextUrl.searchParams;
  const dir = notificationsDir();
  if (q.get("count") === "1") {
    return NextResponse.json({ unread: unreadCount(readProfileInbox(dir, viewer.user.id, viewer.profile.id)) }, { headers: { "Cache-Control": "no-store" } });
  }
  const page = listNotifications(dir, viewer.user.id, viewer.profile.id, {
    limit: Number(q.get("limit")) || 20,
    cursor: q.get("cursor"),
    unreadOnly: q.get("unread") === "1",
  });
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}

const ACTIONS: NotificationAction[] = ["read", "unread", "dismiss", "read-all"];

/** { action: "read" | "unread" | "dismiss" | "read-all", ids?: string[] } for this profile only. */
export async function POST(request: NextRequest) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const tooMany = limited(request, viewer.user.id, "actions", ACTIONS_PER_USER);
  if (tooMany) return tooMany;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; ids?: unknown };
  const action = ACTIONS.find((a) => a === body.action);
  if (!action) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string" && /^[a-f0-9]{24}$/.test(i)).slice(0, 100) : [];
  if (action !== "read-all" && ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });
  const dir = notificationsDir();
  const changed = applyAction(dir, viewer.user.id, viewer.profile.id, action, ids);
  return NextResponse.json({ changed, unread: unreadCount(readProfileInbox(dir, viewer.user.id, viewer.profile.id)) });
}
