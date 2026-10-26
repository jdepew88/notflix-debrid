import { NextRequest, NextResponse } from "next/server";
import { hasOwner } from "@/lib/users";
import { createSetupToken, setupCodeMatches, setupCookie } from "@/lib/config-access";
import { serverConfig } from "@/lib/install/runtime";
import { clientAddress, recordHit, retryAfter, tooManyAttempts } from "@/lib/rate-limit";

const UNLOCK_PER_ADDRESS = { max: 8, windowMs: 15 * 60_000 };
const UNLOCK_GLOBAL = { max: 40, windowMs: 15 * 60_000 };

/**
 * Proves the person running setup has access to the server: they type the one-time code from the
 * launcher window / `<data>\setup-code.txt`. Only possible before the owner account exists.
 */
export async function POST(request: NextRequest) {
  if (serverConfig().setup.completed || hasOwner()) {
    return NextResponse.json({ error: "Setup has already been completed on this server.", code: "setup_done" }, { status: 409 });
  }
  const key = `setup-unlock:${clientAddress(request)}`;
  const wait = Math.max(retryAfter(key, UNLOCK_PER_ADDRESS), retryAfter("setup-unlock:*", UNLOCK_GLOBAL));
  if (wait > 0) {
    const limited = tooManyAttempts(wait, "setup code attempts");
    return NextResponse.json(limited.body, limited.init);
  }
  const body = await request.json().catch(() => ({}));
  if (!setupCodeMatches(body.code)) {
    recordHit(key, UNLOCK_PER_ADDRESS);
    recordHit("setup-unlock:*", UNLOCK_GLOBAL);
    return NextResponse.json({ error: "That setup code is not correct.", code: "bad_code" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(setupCookie(createSetupToken(), request));
  return response;
}
