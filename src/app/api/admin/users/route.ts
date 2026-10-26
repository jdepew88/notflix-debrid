import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createUser, getUserById, listUsers, resetPassword, roleOf, setUserRole } from "@/lib/users";
import { serverConfig, updateConfig } from "@/lib/install/runtime";

function listing(viewer: { user: { id: string }; role: string }) {
  return { users: listUsers(), you: viewer.user.id, yourRole: viewer.role, allowSignup: serverConfig().accounts.allowSignup };
}

/**
 * Account administration: create accounts, grant/revoke admin (owner only), reset passwords,
 * open or close self-service sign-up (owner only).
 */
export async function GET() {
  const viewer = await requireAdmin();
  if (viewer instanceof NextResponse) return viewer;
  return NextResponse.json(listing(viewer));
}

export async function POST(request: NextRequest) {
  const viewer = await requireAdmin();
  if (viewer instanceof NextResponse) return viewer;
  const body = await request.json().catch(() => ({}));

  try {
    if (body.action === "create") {
      const role = body.role === "admin" ? "admin" : "user";
      if (role === "admin" && viewer.role !== "owner") {
        return NextResponse.json({ error: "Only the owner can create administrators." }, { status: 403 });
      }
      await createUser(String(body.name ?? ""), String(body.password ?? ""), {
        role,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      });
      return NextResponse.json(listing(viewer));
    }
    if (body.action === "setSignup") {
      if (viewer.role !== "owner") return NextResponse.json({ error: "Only the owner can change sign-up." }, { status: 403 });
      updateConfig((cfg) => {
        cfg.accounts.allowSignup = body.allowSignup === true;
      });
      return NextResponse.json(listing(viewer));
    }

    const target = typeof body.userId === "string" ? getUserById(body.userId) : null;
    if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    const targetRole = roleOf(target);

    if (body.action === "setRole") {
      if (viewer.role !== "owner") return NextResponse.json({ error: "Only the owner can change roles." }, { status: 403 });
      if (body.role !== "admin" && body.role !== "user") return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      setUserRole(target.id, body.role);
      return NextResponse.json(listing(viewer));
    }
    if (body.action === "resetPassword") {
      if (target.id === viewer.user.id) return NextResponse.json({ error: "Use Change password for your own account." }, { status: 400 });
      // Administrators may reset regular accounts; only the owner may reset another administrator.
      if (targetRole === "owner" || (targetRole === "admin" && viewer.role !== "owner")) {
        return NextResponse.json({ error: "You cannot reset this account's password." }, { status: 403 });
      }
      const temporaryPassword = await resetPassword(target.id);
      return NextResponse.json({ temporaryPassword, ...listing(viewer) });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
  }
}
