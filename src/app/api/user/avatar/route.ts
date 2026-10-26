import { NextRequest, NextResponse } from "next/server";
import { requireViewer, verifyPassword } from "@/lib/auth";
import { publicProfile, publicUserState, readUserState, setProfileAvatar, verifyProfilePin } from "@/lib/users";
import { isRestricted, profileMaturity } from "@/lib/maturity";
import { DEFAULT_AVATAR } from "@/lib/avatars";
import { AvatarError, MAX_UPLOAD_BYTES, deleteProfileAvatarFiles, parseCrop, processAvatar, saveAvatarFile } from "@/lib/avatar-store";

/**
 * Upload a profile photo: multipart form with `profileId`, `file` (JPEG/PNG/WebP, ≤ 8 MB) and
 * `crop` (JSON {x, y, size} in oriented image pixels). Same permission rules as editing a profile.
 */
export async function POST(request: NextRequest) {
  const viewer = await requireViewer();
  if (viewer instanceof NextResponse) return viewer;

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "Images must be 8 MB or smaller." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected an image upload." }, { status: 400 });
  }
  const profileId = String(form.get("profileId") ?? "");
  const target = viewer.state.profiles.find((p) => p.id === profileId);
  if (!target) return NextResponse.json({ error: "Unknown profile" }, { status: 404 });

  const current = viewer.profile?.id ?? null;
  if (viewer.profile && isRestricted(profileMaturity(viewer.profile)) && target.id !== current) {
    return NextResponse.json({ error: "Kids profiles can only edit themselves." }, { status: 403 });
  }
  if (target.pinHash && target.id !== current) {
    const pin = form.get("pin");
    const password = form.get("password");
    const ok = (await verifyProfilePin(target, typeof pin === "string" ? pin : undefined)) ||
      (typeof password === "string" && password.length > 0 && (await verifyPassword(password, viewer.user.passwordHash)));
    if (!ok) return NextResponse.json({ error: "Enter this profile's PIN to change it.", code: "pin_required" }, { status: 403 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Images must be 8 MB or smaller." }, { status: 413 });

  try {
    const webp = await processAvatar(Buffer.from(await file.arrayBuffer()), parseCrop(form.get("crop")));
    const name = saveAvatarFile(viewer.user.id, target.id, webp);
    const { profile } = setProfileAvatar(viewer.user.id, target.id, `upload:${name}`);
    const state = publicUserState(readUserState(viewer.user.id));
    return NextResponse.json({ profile: publicProfile(profile), state: { ...state, activeProfileId: current }, bytes: webp.length });
  } catch (err) {
    if (err instanceof AvatarError) return NextResponse.json({ error: err.message }, { status: 422 });
    console.error("[notflix] avatar upload failed:", err);
    return NextResponse.json({ error: "The image could not be processed." }, { status: 500 });
  }
}

/** Removes an uploaded photo (the profile falls back to a built-in avatar). */
export async function DELETE(request: NextRequest) {
  const viewer = await requireViewer();
  if (viewer instanceof NextResponse) return viewer;
  const profileId = request.nextUrl.searchParams.get("profileId") ?? "";
  const target = viewer.state.profiles.find((p) => p.id === profileId);
  if (!target) return NextResponse.json({ error: "Unknown profile" }, { status: 404 });
  if (target.id !== viewer.profile?.id && (target.pinHash || (viewer.profile && isRestricted(profileMaturity(viewer.profile))))) {
    return NextResponse.json({ error: "Switch to this profile to remove its photo." }, { status: 403 });
  }
  deleteProfileAvatarFiles(viewer.user.id, target.id);
  const { profile } = setProfileAvatar(viewer.user.id, target.id, DEFAULT_AVATAR);
  const state = publicUserState(readUserState(viewer.user.id));
  return NextResponse.json({ profile: publicProfile(profile), state: { ...state, activeProfileId: viewer.profile?.id ?? null } });
}
