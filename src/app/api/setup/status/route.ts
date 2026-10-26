import { NextRequest, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { hasOwner } from "@/lib/users";
import { SETUP_COOKIE, validSetupToken } from "@/lib/config-access";
import { ensureInitialized, serverConfig } from "@/lib/install/runtime";

export const dynamic = "force-dynamic";

/**
 * Public: where first-run setup stands, so the wizard knows which step to show. Reveals nothing
 * about configuration or credentials.
 */
export async function GET(request: NextRequest) {
  ensureInitialized();
  const cfg = serverConfig();
  const owner = hasOwner();
  const viewer = owner ? await getViewer() : null;
  return NextResponse.json({
    setupComplete: cfg.setup.completed,
    ownerExists: owner,
    unlocked: !owner && validSetupToken(request.cookies.get(SETUP_COOKIE)?.value),
    signedInAsOwner: viewer?.role === "owner",
    stepsDone: viewer?.role === "owner" || !owner ? cfg.setup.stepsDone : [],
    // For the sign-in page: whether to offer "Create an account".
    signupOpen: cfg.setup.completed && cfg.accounts.allowSignup,
  });
}
