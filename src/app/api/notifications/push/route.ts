import { NextRequest, NextResponse } from "next/server";
import { checkEndpoint, checkKeys, listSubscriptions, removeSubscription, saveSubscription } from "@/lib/notifications/subscriptions";
import { notificationsDir, vapidKeys } from "@/lib/notifications/server";
import { PUSH_CHANGES_PER_USER, crossSiteRefusal, limited, requireProfileViewer } from "@/lib/notifications/http";

export const dynamic = "force-dynamic";

/** The public VAPID key (applicationServerKey) and whether this profile has subscribed browsers. */
export async function GET(request: NextRequest) {
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const endpoint = request.nextUrl.searchParams.get("endpoint");
  const subs = listSubscriptions(notificationsDir(), { accountId: viewer.user.id, profileId: viewer.profile.id });
  return NextResponse.json(
    {
      publicKey: vapidKeys().publicKey,
      subscriptions: subs.length,
      // Whether the browser asking is registered for this profile (it passes its own endpoint).
      thisBrowser: endpoint ? subs.some((s) => s.endpoint === endpoint) : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Registers this browser's push subscription for the profile in use. */
export async function POST(request: NextRequest) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const tooMany = limited(request, viewer.user.id, "push", PUSH_CHANGES_PER_USER);
  if (tooMany) return tooMany;
  const body = (await request.json().catch(() => ({}))) as { subscription?: { endpoint?: unknown; keys?: unknown }; label?: unknown };
  const endpointError = checkEndpoint(body.subscription?.endpoint);
  if (endpointError) return NextResponse.json({ error: endpointError }, { status: 400 });
  const keys = checkKeys(body.subscription?.keys);
  if (!keys) return NextResponse.json({ error: "Invalid subscription keys" }, { status: 400 });
  const label = typeof body.label === "string" ? body.label.replace(/[^\w .()-]/g, "").slice(0, 60) : undefined;
  saveSubscription(notificationsDir(), {
    accountId: viewer.user.id,
    profileId: viewer.profile.id,
    endpoint: body.subscription!.endpoint as string,
    ...keys,
    label,
    sessionVersion: viewer.user.sessionVersion ?? 0,
  });
  return NextResponse.json({ ok: true });
}

/** Removes this browser's subscription ({ endpoint }); only one owned by this account. */
export async function DELETE(request: NextRequest) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const viewer = await requireProfileViewer();
  if (viewer instanceof NextResponse) return viewer;
  const tooMany = limited(request, viewer.user.id, "push", PUSH_CHANGES_PER_USER);
  if (tooMany) return tooMany;
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string") return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  return NextResponse.json({ removed: removeSubscription(notificationsDir(), viewer.user.id, body.endpoint) });
}
