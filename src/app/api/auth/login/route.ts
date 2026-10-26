import { NextRequest, NextResponse } from "next/server";
import { authenticateUser, plausiblePassword, roleOf } from "@/lib/users";
import { createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { clearedProfileCookie } from "@/lib/session";
import {
  LOGIN_PER_ACCOUNT,
  LOGIN_PER_ADDRESS,
  clearHits,
  clientAddress,
  recordHit,
  retryAfter,
  tooManyAttempts,
} from "@/lib/rate-limit";

/** Account-wide cap across all addresses (slows distributed guessing without locking out quickly). */
const LOGIN_ACCOUNT_WIDE = { max: 20, windowMs: 15 * 60_000 };
const INVALID = "Incorrect username or password.";

// Relative Location: the redirect never depends on Host or X-Forwarded-* headers a client controls.
function seeOther(location: string, init?: ResponseInit): NextResponse {
  const res = new NextResponse(null, { ...init, status: 303 });
  res.headers.set("Location", location);
  return res;
}

// The no-JavaScript fallback only carries a short code; the login page maps it to fixed text, so a
// crafted link cannot make the page display arbitrary wording.
const ERROR_CODES: Record<string, string> = {
  [INVALID]: "invalid",
  "Enter your username and password.": "missing",
};

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const formPost = !contentType.includes("application/json");
  const fail = (message: string, status: number, extra?: ResponseInit) =>
    formPost
      ? seeOther(`/?error=${status === 429 ? "rate_limited" : ERROR_CODES[message] ?? "failed"}`)
      : NextResponse.json({ error: message }, { status, ...extra });

  try {
    let name = "";
    let password = "";
    let remember = true;
    if (formPost) {
      const form = await request.formData();
      name = String(form.get("name") ?? "").trim();
      password = String(form.get("password") ?? "");
      remember = form.get("remember") !== null || form.get("rememberPresent") === null;
    } else {
      const body = await request.json();
      name = String(body.name ?? "").trim();
      password = String(body.password ?? "");
      remember = body.remember !== false;
    }
    if (!name || !password) return fail("Enter your username and password.", 400);

    const address = clientAddress(request);
    const accountKey = `login:${name.toLowerCase()}|${address}`;
    const accountWideKey = `login:${name.toLowerCase()}`;
    const addressKey = `login-ip:${address}`;
    const wait = Math.max(
      retryAfter(accountKey, LOGIN_PER_ACCOUNT),
      retryAfter(accountWideKey, LOGIN_ACCOUNT_WIDE),
      retryAfter(addressKey, LOGIN_PER_ADDRESS)
    );
    if (wait > 0) {
      const limited = tooManyAttempts(wait, "sign-in attempts");
      return formPost ? fail(limited.body.error, 429) : NextResponse.json(limited.body, limited.init);
    }

    const user = plausiblePassword(password) ? await authenticateUser(name, password) : null;
    if (!user) {
      recordHit(accountKey, LOGIN_PER_ACCOUNT);
      recordHit(accountWideKey, LOGIN_ACCOUNT_WIDE);
      recordHit(addressKey, LOGIN_PER_ADDRESS);
      return fail(INVALID, 401);
    }
    clearHits(accountKey);

    const token = await createSessionToken(user.id, { version: user.sessionVersion ?? 0, remember });
    const response = formPost
      ? seeOther("/profiles")
      : NextResponse.json({ user: { id: user.id, name: user.name, role: roleOf(user) } });
    response.cookies.set(sessionCookieOptions(token, request, { remember }));
    // A new sign-in always starts at "Who's watching?".
    response.cookies.set(clearedProfileCookie(request));
    return response;
  } catch (err) {
    console.error("[notflix] sign-in failed:", err);
    return fail("Sign-in is unavailable right now. Try again in a moment.", 500);
  }
}
