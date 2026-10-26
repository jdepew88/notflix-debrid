import { NextRequest, NextResponse } from "next/server";
import { requireViewer, verifyPassword, type Viewer } from "@/lib/auth";
import { clearedProfileCookie, createProfileToken, profileCookieOptions } from "@/lib/session";
import {
  addProfile,
  publicProfile,
  publicUserState,
  readUserState,
  removeProfile,
  setProfilePin,
  setProfileRestrictions,
  updateProfile,
  verifyProfilePin,
  writeUserState,
} from "@/lib/users";
import { isMaturityLevel, isRestricted, profileMaturity } from "@/lib/maturity";
import { PIN_PER_PROFILE, clearHits, recordHit, retryAfter, tooManyAttempts } from "@/lib/rate-limit";
import { deleteProfileAvatarFiles } from "@/lib/avatar-store";
import type { UserProfile } from "@/lib/types";

/**
 * Profile management. Profiles live inside an account; these rules stop a kids profile (or anyone at
 * an unattended, signed-in browser) from escaping its restrictions:
 *  - entering a PIN-protected profile needs its PIN (rate limited);
 *  - changing a PIN or kids/maturity settings needs the account password;
 *  - a restricted profile may only rename or re-avatar itself;
 *  - editing or deleting another PIN-protected profile needs that PIN (or the account password);
 *  - adding an unrestricted profile while restricted ones exist needs the account password, unless
 *    the request comes from an unrestricted profile.
 */
type Body = Record<string, unknown> & { action?: string; profileId?: string; pin?: unknown; password?: unknown };

const bad = (error: string, status = 400, code?: string) => NextResponse.json({ error, ...(code ? { code } : {}) }, { status });

function stateResponse(userId: string, activeProfileId: string | null, extra: Record<string, unknown> = {}) {
  const state = publicUserState(readUserState(userId));
  return { ...extra, state: { ...state, activeProfileId } };
}

async function passwordOk(viewer: Viewer, password: unknown): Promise<boolean> {
  return typeof password === "string" && password.length > 0 && (await verifyPassword(password, viewer.user.passwordHash));
}

function inUnrestrictedProfile(viewer: Viewer): boolean {
  return viewer.profile !== null && !isRestricted(profileMaturity(viewer.profile));
}

function inRestrictedProfile(viewer: Viewer): boolean {
  return viewer.profile !== null && isRestricted(profileMaturity(viewer.profile));
}

/** PIN check for acting on another protected profile (PIN or account password), rate limited. */
async function unlockOther(viewer: Viewer, target: UserProfile, body: Body): Promise<NextResponse | null> {
  if (!target.pinHash || target.id === viewer.profile?.id) return null;
  const key = `pin:${viewer.user.id}:${target.id}`;
  const wait = retryAfter(key, PIN_PER_PROFILE);
  if (wait > 0) {
    const limited = tooManyAttempts(wait, "PIN attempts");
    return NextResponse.json(limited.body, limited.init);
  }
  if ((await verifyProfilePin(target, body.pin)) || (await passwordOk(viewer, body.password))) {
    clearHits(key);
    return null;
  }
  recordHit(key, PIN_PER_PROFILE);
  return bad("Enter this profile's PIN to change it.", 403, "pin_required");
}

export async function POST(request: NextRequest) {
  const viewer = await requireViewer();
  if (viewer instanceof NextResponse) return viewer;
  const body = (await request.json().catch(() => ({}))) as Body;
  const userId = viewer.user.id;
  const target = typeof body.profileId === "string" ? viewer.state.profiles.find((p) => p.id === body.profileId) ?? null : null;
  const current = viewer.profile?.id ?? null;

  try {
    switch (body.action) {
      case "select": {
        if (!target) return bad("Unknown profile", 404);
        if (target.pinHash && target.id !== current) {
          const key = `pin:${userId}:${target.id}`;
          const wait = retryAfter(key, PIN_PER_PROFILE);
          if (wait > 0) {
            const limited = tooManyAttempts(wait, "PIN attempts");
            return NextResponse.json(limited.body, limited.init);
          }
          if (!(await verifyProfilePin(target, body.pin))) {
            recordHit(key, PIN_PER_PROFILE);
            return bad(body.pin ? "That PIN is not correct." : "This profile is locked with a PIN.", 403, "pin_required");
          }
          clearHits(key);
        }
        const state = readUserState(userId);
        state.activeProfileId = target.id;
        writeUserState(userId, state);
        const response = NextResponse.json(stateResponse(userId, target.id, { profile: publicProfile(target) }));
        response.cookies.set(profileCookieOptions(await createProfileToken(userId, target.id), request));
        return response;
      }

      case "leave": {
        const response = NextResponse.json(stateResponse(userId, null));
        response.cookies.set(clearedProfileCookie(request));
        return response;
      }

      case "create": {
        if (inRestrictedProfile(viewer)) return bad("Kids profiles cannot add profiles.", 403, "restricted_profile");
        const isKids = body.isKids === true;
        const maturity = isMaturityLevel(body.maturity) ? body.maturity : isKids ? "kids" : "all";
        const unrestricted = !isKids && maturity === "all";
        const hasRestricted = viewer.state.profiles.some((p) => isRestricted(profileMaturity(p)));
        if (unrestricted && hasRestricted && !inUnrestrictedProfile(viewer) && !(await passwordOk(viewer, body.password))) {
          return bad("Enter the account password to add a profile without maturity restrictions.", 403, "password_required");
        }
        const profile = addProfile(userId, { name: body.name, avatar: body.avatar, isKids, maturity });
        return NextResponse.json(stateResponse(userId, current, { profile: publicProfile(profile) }));
      }

      case "update": {
        if (!target) return bad("Unknown profile", 404);
        if (inRestrictedProfile(viewer) && target.id !== current) return bad("Kids profiles can only edit themselves.", 403, "restricted_profile");
        const locked = await unlockOther(viewer, target, body);
        if (locked) return locked;
        const profile = updateProfile(userId, target.id, { name: body.name, avatar: body.avatar });
        return NextResponse.json(stateResponse(userId, current, { profile: publicProfile(profile) }));
      }

      case "restrictions": {
        if (!target) return bad("Unknown profile", 404);
        if (!(await passwordOk(viewer, body.password))) return bad("The account password is required to change maturity settings.", 403, "password_required");
        const isKids = body.isKids === true;
        const maturity = isMaturityLevel(body.maturity) ? body.maturity : isKids ? "kids" : "all";
        const profile = setProfileRestrictions(userId, target.id, isKids, maturity);
        return NextResponse.json(stateResponse(userId, current, { profile: publicProfile(profile) }));
      }

      case "setPin": {
        if (!target) return bad("Unknown profile", 404);
        if (!(await passwordOk(viewer, body.password))) return bad("The account password is required to change a profile lock.", 403, "password_required");
        const pin = body.pin === null || body.pin === "" ? null : String(body.pin ?? "");
        const profile = await setProfilePin(userId, target.id, pin);
        return NextResponse.json(stateResponse(userId, current, { profile: publicProfile(profile) }));
      }

      case "delete": {
        if (!target) return bad("Unknown profile", 404);
        if (inRestrictedProfile(viewer)) return bad("Kids profiles cannot delete profiles.", 403, "restricted_profile");
        const locked = await unlockOther(viewer, target, body);
        if (locked) return locked;
        const removed = removeProfile(userId, target.id);
        deleteProfileAvatarFiles(userId, removed.id);
        const activeAfter = current === removed.id ? null : current;
        const response = NextResponse.json(stateResponse(userId, activeAfter));
        if (current === removed.id) response.cookies.set(clearedProfileCookie(request));
        return response;
      }

      default:
        return bad("Unknown action");
    }
  } catch (err) {
    return bad(err instanceof Error ? err.message : "Could not update profiles");
  }
}
