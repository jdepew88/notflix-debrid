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

function publicUrl(request: NextRequest, path: string): URL {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  const proto = (
    request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "")
  )
    .split(",")[0]
    .trim();
  if (host) return new URL(path, `${proto}://${host}`);
  return new URL(path, request.url);
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const formPost = !contentType.includes("application/json");
  const fail = (message: string, status: number, extra?: ResponseInit) =>
    formPost
      ? NextResponse.redirect(publicUrl(request, `/?error=${encodeURIComponent(message)}`), 303)
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
      ? NextResponse.redirect(publicUrl(request, "/profiles"), 303)
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
