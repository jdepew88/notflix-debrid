import { NextRequest, NextResponse } from "next/server";
import { OwnerExistsError, createOwner, hasOwner, roleOf } from "@/lib/users";
import { createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { clearedProfileCookie } from "@/lib/session";
import { SETUP_COOKIE, clearedSetupCookie, validSetupToken } from "@/lib/config-access";
import { dataDir, serverConfig, updateConfig } from "@/lib/install/runtime";
import { removeSetupCode } from "@/lib/install/init.mjs";

/**
 * Step 2 of setup: creates the owner (administrator) account. Requires the setup code session,
 * succeeds at most once (a lock serializes concurrent attempts), and signs the owner in.
 */
export async function POST(request: NextRequest) {
  if (serverConfig().setup.completed || hasOwner()) {
    return NextResponse.json({ error: "This server already has an owner.", code: "owner_exists" }, { status: 409 });
  }
  if (!validSetupToken(request.cookies.get(SETUP_COOKIE)?.value)) {
    return NextResponse.json({ error: "Enter the setup code first.", code: "setup_code_required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");
  const confirm = String(body.confirm ?? "");
  if (password !== confirm) return NextResponse.json({ error: "Passwords don't match." }, { status: 400 });

  let owner;
  try {
    owner = await createOwner(name, password, typeof body.displayName === "string" ? body.displayName : undefined);
  } catch (err) {
    if (err instanceof OwnerExistsError) {
      return NextResponse.json({ error: err.message, code: "owner_exists" }, { status: 409 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not create the account." }, { status: 400 });
  }

  updateConfig((cfg) => {
    cfg.setup.ownerCreatedAt = new Date().toISOString();
    if (!cfg.setup.stepsDone.includes("owner")) cfg.setup.stepsDone.push("owner");
  });
  // From now on the owner's session protects setup; the code has served its purpose.
  removeSetupCode(dataDir());

  const token = await createSessionToken(owner.id, { version: owner.sessionVersion ?? 0, remember: true });
  const response = NextResponse.json({ user: { id: owner.id, name: owner.name, displayName: owner.displayName, role: roleOf(owner) } });
  response.cookies.set(sessionCookieOptions(token, request, { remember: true }));
  response.cookies.set(clearedProfileCookie(request));
  response.cookies.set(clearedSetupCookie(request));
  return response;
}
