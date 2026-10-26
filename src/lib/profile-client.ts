"use client";

import { useAppStore } from "./store";
import type { UserProfile } from "./types";
import type { MaturityLevel } from "./maturity";

export interface ProfileApiResult {
  ok: boolean;
  error?: string;
  /** e.g. "pin_required", "password_required", "rate_limited". */
  code?: string;
  profile?: UserProfile;
}

type StatePayload = Parameters<ReturnType<typeof useAppStore.getState>["hydrateUserState"]>[0];

function applyState(data: { state?: StatePayload }) {
  if (!data.state) return;
  const store = useAppStore.getState();
  store.hydrateUserState(data.state);
  // The server reports which profile this browser is using after the change.
  store.setActiveProfile(data.state.activeProfileId ?? null);
}

async function call(body: Record<string, unknown>): Promise<ProfileApiResult> {
  try {
    const res = await fetch("/api/user/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || (res.status === 401 ? "Your session expired. Sign in again." : "Something went wrong."), code: data.code };
    }
    applyState(data);
    return { ok: true, profile: data.profile };
  } catch {
    return { ok: false, error: "Could not reach Notflix. Check your connection." };
  }
}

/** Selects a profile (PIN for protected profiles). The server sets the signed profile cookie. */
export const selectProfile = (profileId: string, pin?: string) => call({ action: "select", profileId, pin });
/** Forgets the profile for this browser (Switch profiles). */
export const leaveProfile = () => call({ action: "leave" });
export const createProfile = (input: { name: string; avatar: string; isKids: boolean; maturity?: MaturityLevel; password?: string }) =>
  call({ action: "create", ...input });
export const updateProfile = (profileId: string, input: { name?: string; avatar?: string; pin?: string; password?: string }) =>
  call({ action: "update", profileId, ...input });
export const setProfileRestrictions = (profileId: string, isKids: boolean, maturity: MaturityLevel, password: string) =>
  call({ action: "restrictions", profileId, isKids, maturity, password });
export const setProfilePin = (profileId: string, pin: string | null, password: string) => call({ action: "setPin", profileId, pin, password });
export const deleteProfile = (profileId: string, unlock?: { pin?: string; password?: string }) => call({ action: "delete", profileId, ...unlock });

export interface CropRect {
  x: number;
  y: number;
  size: number;
}

/** Uploads a photo; the server validates it, applies the crop and stores a 256 px WebP. */
export async function uploadAvatar(profileId: string, file: Blob, crop: CropRect, unlock?: { pin?: string; password?: string }): Promise<ProfileApiResult> {
  const form = new FormData();
  form.set("profileId", profileId);
  form.set("file", file);
  form.set("crop", JSON.stringify(crop));
  if (unlock?.pin) form.set("pin", unlock.pin);
  if (unlock?.password) form.set("password", unlock.password);
  try {
    const res = await fetch("/api/user/avatar", { method: "POST", body: form, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || "Upload failed.", code: data.code };
    applyState(data);
    return { ok: true, profile: data.profile };
  } catch {
    return { ok: false, error: "Could not reach Notflix. Check your connection." };
  }
}
