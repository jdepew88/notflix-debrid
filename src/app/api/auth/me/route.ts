import { NextRequest, NextResponse } from "next/server";
import { clearedSessionCookie, getViewer } from "@/lib/auth";
import { clearedProfileCookie } from "@/lib/session";
import { hasOwner, isAdminRole, publicUserState } from "@/lib/users";

export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) {
    // Clear a cookie that is invalid, revoked or belongs to an account that no longer exists.
    // Otherwise the proxy keeps treating the browser as signed in and bounces it between "/" and "/profiles".
    const response = NextResponse.json({ user: null }, { status: 401 });
    if (request.cookies.has("notflix_session")) response.cookies.set(clearedSessionCookie(request));
    if (request.cookies.has("notflix_profile")) response.cookies.set(clearedProfileCookie(request));
    return response;
  }
  const state = publicUserState(viewer.state);
  return NextResponse.json({
    user: { id: viewer.user.id, name: viewer.user.name, role: viewer.role, isAdmin: isAdminRole(viewer.role) },
    // The server's record of this browser's profile (signed cookie), not a client-chosen value.
    state: { ...state, activeProfileId: viewer.profile?.id ?? null },
    maturity: viewer.maturity,
    ownerClaimable: !hasOwner(),
  });
}
