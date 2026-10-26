import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth";
import {
  publicUserState,
  readUserState,
  updateProfilePreferences,
  updateTitlePreferences,
  writeUserState,
} from "@/lib/users";

function viewState(userId: string, activeProfileId: string | null) {
  return { ...publicUserState(readUserState(userId)), activeProfileId };
}

export async function GET() {
  const viewer = await requireViewer();
  if (viewer instanceof NextResponse) return viewer;
  return NextResponse.json({ state: viewState(viewer.user.id, viewer.profile?.id ?? null) });
}

/**
 * Saves My List, queue, progress and preferences for the profile this browser is using (the signed
 * profile cookie). Data for other profiles in the request is ignored, so one profile can never
 * overwrite another's list or history. Profiles themselves change only through /api/user/profiles.
 */
export async function PUT(request: NextRequest) {
  const viewer = await requireViewer();
  if (viewer instanceof NextResponse) return viewer;
  const userId = viewer.user.id;
  const active = viewer.profile?.id ?? null;
  if (!active) return NextResponse.json({ error: "Choose a profile first.", code: "no_profile" }, { status: 409 });

  const body = await request.json().catch(() => ({}));

  if (body.action === "setPreferences") {
    if (body.profileId !== undefined && body.profileId !== active) {
      return NextResponse.json({ error: "Preferences can only be changed for the profile in use." }, { status: 403 });
    }
    try {
      const preferences = updateProfilePreferences(userId, active, body.preferences);
      return NextResponse.json({ preferences, state: viewState(userId, active) });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save preferences" }, { status: 400 });
    }
  }

  if (body.action === "setTitlePreferences") {
    if (typeof body.watchId !== "string" || (body.profileId !== undefined && body.profileId !== active)) {
      return NextResponse.json({ error: "watchId required for the profile in use" }, { status: 400 });
    }
    const preferences = updateTitlePreferences(userId, active, body.watchId.slice(0, 200), body.patch ?? {});
    return NextResponse.json({ preferences, state: viewState(userId, active) });
  }

  const current = readUserState(userId);
  const pick = <T,>(map: unknown): T | undefined => {
    if (!map || typeof map !== "object") return undefined;
    const value = (map as Record<string, unknown>)[active];
    return value === undefined ? undefined : (value as T);
  };

  const myList = pick<string[]>(body.myListByProfile);
  if (Array.isArray(myList)) current.myListByProfile[active] = myList.filter((x) => typeof x === "string").slice(0, 2000);
  const queue = pick<Array<{ id: string; addedAt: number }>>(body.queueByProfile);
  if (Array.isArray(queue)) current.queueByProfile = { ...(current.queueByProfile ?? {}), [active]: queue.slice(0, 2000) };
  const progress = pick<Record<string, number>>(body.continueWatchingByProfile);
  if (progress && typeof progress === "object") current.continueWatchingByProfile[active] = progress;
  const last = pick<NonNullable<typeof current.lastWatchedByProfile>[string]>(body.lastWatchedByProfile);
  if (last && typeof last === "object") current.lastWatchedByProfile = { ...(current.lastWatchedByProfile ?? {}), [active]: last };

  writeUserState(userId, current);
  return NextResponse.json({ state: viewState(userId, active) });
}
