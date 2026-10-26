import { NextRequest, NextResponse } from "next/server";
import { createUser, roleOf } from "@/lib/users";
import { createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { clearedProfileCookie } from "@/lib/session";
import { serverConfig } from "@/lib/install/runtime";
import { SIGNUP_PER_ADDRESS, clientAddress, recordHit, retryAfter, tooManyAttempts } from "@/lib/rate-limit";

/**
 * Self-service sign-up. Closed by default: the owner creates accounts in Settings → Accounts or
 * opens sign-ups there. It never creates the owner (first-run setup does that) and is unavailable
 * until setup is finished.
 */
export async function POST(request: NextRequest) {
  const cfg = serverConfig();
  if (!cfg.setup.completed) {
    return NextResponse.json({ error: "This server is not set up yet.", code: "setup_required" }, { status: 403 });
  }
  if (!cfg.accounts.allowSignup) {
    return NextResponse.json(
      { error: "New accounts are created by the server owner. Ask them to add you in Settings → Accounts.", code: "signup_closed" },
      { status: 403 }
    );
  }
  const addressKey = `signup:${clientAddress(request)}`;
  const wait = retryAfter(addressKey, SIGNUP_PER_ADDRESS);
  if (wait > 0) {
    const limited = tooManyAttempts(wait, "new accounts from this network");
    return NextResponse.json(limited.body, limited.init);
  }
  try {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const password = String(body.password ?? "");
    const remember = body.remember !== false;

    const user = await createUser(name, password, { displayName: typeof body.displayName === "string" ? body.displayName : undefined });
    recordHit(addressKey, SIGNUP_PER_ADDRESS);
    const token = await createSessionToken(user.id, { version: user.sessionVersion ?? 0, remember });
    const response = NextResponse.json({
      user: { id: user.id, name: user.name, displayName: user.displayName, role: roleOf(user) },
    });
    response.cookies.set(sessionCookieOptions(token, request, { remember }));
    response.cookies.set(clearedProfileCookie(request));
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sign up failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
