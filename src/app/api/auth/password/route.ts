import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, getSessionUserId, sessionCookieOptions } from "@/lib/auth";
import { changePassword } from "@/lib/users";
import { LOGIN_PER_ACCOUNT, recordHit, retryAfter, tooManyAttempts } from "@/lib/rate-limit";

/** Changes the signed-in account's password. Other browsers are signed out; this one stays signed in. */
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const key = `password:${userId}`;
  const wait = retryAfter(key, LOGIN_PER_ACCOUNT);
  if (wait > 0) {
    const limited = tooManyAttempts(wait, "password attempts");
    return NextResponse.json(limited.body, limited.init);
  }
  const body = await request.json().catch(() => ({}));
  try {
    const user = await changePassword(userId, String(body.current ?? ""), String(body.next ?? ""));
    const response = NextResponse.json({ success: true });
    response.cookies.set(sessionCookieOptions(await createSessionToken(user.id, { version: user.sessionVersion ?? 0 }), request));
    return response;
  } catch (err) {
    recordHit(key, LOGIN_PER_ACCOUNT);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not change password" }, { status: 400 });
  }
}
