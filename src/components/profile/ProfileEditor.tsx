"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, Lock, Trash2, Upload, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { ProfileAvatar } from "./ProfileAvatar";
import { AvatarCropper, ACCEPTED_TYPES, checkAvatarFile } from "./AvatarCropper";
import { AVATAR_COLLECTIONS, BUILTIN_AVATARS } from "@/lib/avatars";
import { MATURITY_LEVELS, profileMaturity, type MaturityLevel } from "@/lib/maturity";
import {
  createProfile,
  deleteProfile,
  setProfilePin,
  setProfileRestrictions,
  updateProfile,
  uploadAvatar,
  type CropRect,
} from "@/lib/profile-client";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/cn";

type AvatarChoice = { kind: "keep" } | { kind: "builtin"; id: string } | { kind: "upload"; file: File; crop: CropRect | null; preview: string | null };

interface ProfileEditorProps {
  mode: "create" | "edit";
  profile?: UserProfile;
  /** PIN already entered to unlock another protected profile for editing. */
  unlockPin?: string;
  canDelete?: boolean;
  onClose: () => void;
}

const DEFAULT_NEW_AVATARS = ["v2-animals-fox", "v2-space-astronaut", "v2-monsters-cyclops", "v2-sci-fi-android", "v2-mythical-dragon", "v2-portraits-headphones"];

export function ProfileEditor({ mode, profile, unlockPin, canDelete, onClose }: ProfileEditorProps) {
  const titleId = useId();
  const nameId = useId();
  const passwordId = useId();
  const pinId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [initialAvatar] = useState(() => profile?.avatar ?? `builtin:${DEFAULT_NEW_AVATARS[Math.floor(Math.random() * DEFAULT_NEW_AVATARS.length)]}`);
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState<AvatarChoice>(mode === "create" ? { kind: "builtin", id: initialAvatar.slice(8) } : { kind: "keep" });
  const [collection, setCollection] = useState<string>("all");
  const [isKids, setIsKids] = useState(Boolean(profile?.isKids));
  const [maturity, setMaturity] = useState<MaturityLevel>(profileMaturity(profile));
  const [pinEnabled, setPinEnabled] = useState(Boolean(profile?.hasPin));
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const restrictionsChanged = mode === "edit" && (isKids !== Boolean(profile?.isKids) || maturity !== profileMaturity(profile));
  const pinChanged = mode === "edit" && (pinEnabled !== Boolean(profile?.hasPin) || (pinEnabled && pin.length > 0));
  const passwordRequired = needPassword || restrictionsChanged || pinChanged || (mode === "create" && pinEnabled);

  const previewAvatar =
    avatar.kind === "builtin" ? `builtin:${avatar.id}` : avatar.kind === "keep" ? profile?.avatar : undefined;
  const avatars = useMemo(() => (collection === "all" ? BUILTIN_AVATARS : BUILTIN_AVATARS.filter((a) => a.collection === collection)), [collection]);
  const selectedBuiltin = avatar.kind === "builtin" ? avatar.id : avatar.kind === "keep" && profile?.avatar.startsWith("builtin:") ? profile.avatar.slice(8) : null;
  const levels = isKids ? MATURITY_LEVELS.filter((l) => l.value !== "all") : MATURITY_LEVELS;
  const unlock = { pin: unlockPin, password: password || undefined };

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    const problem = checkAvatarFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setAvatar({ kind: "upload", file, crop: null, preview: null });
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Enter a name for this profile.");
      return;
    }
    if (pinEnabled && (pinChanged || !profile?.hasPin) && !/^\d{4}$/.test(pin)) {
      setError("A profile PIN is exactly 4 digits.");
      return;
    }
    if (passwordRequired && !password) {
      setNeedPassword(true);
      setError("Enter the account password to save these changes.");
      return;
    }
    if (avatar.kind === "upload" && !avatar.crop) {
      setError("That photo can't be used. Choose another image.");
      return;
    }
    setSaving(true);
    try {
      let target = profile;
      if (mode === "create") {
        const result = await createProfile({
          name: name.trim(),
          avatar: avatar.kind === "builtin" ? `builtin:${avatar.id}` : initialAvatar,
          isKids,
          maturity,
          password: password || undefined,
        });
        if (!result.ok || !result.profile) {
          if (result.code === "password_required") setNeedPassword(true);
          setError(result.error ?? "Could not add the profile.");
          return;
        }
        target = result.profile;
      } else if (profile) {
        const patch: { name?: string; avatar?: string } = {};
        if (name.trim() !== profile.name) patch.name = name.trim();
        if (avatar.kind === "builtin") patch.avatar = `builtin:${avatar.id}`;
        if (Object.keys(patch).length) {
          const result = await updateProfile(profile.id, { ...patch, ...unlock });
          if (!result.ok) {
            setError(result.error ?? "Could not save the profile.");
            return;
          }
        }
        if (restrictionsChanged) {
          const result = await setProfileRestrictions(profile.id, isKids, maturity, password);
          if (!result.ok) {
            setError(result.error ?? "Could not change maturity settings.");
            return;
          }
        }
      }
      if (!target) return;
      if (avatar.kind === "upload" && avatar.crop) {
        const result = await uploadAvatar(target.id, avatar.file, avatar.crop, mode === "edit" ? unlock : undefined);
        if (!result.ok) {
          setError(result.error ?? "The photo could not be saved.");
          return;
        }
      }
      if (pinChanged || (mode === "create" && pinEnabled)) {
        const result = await setProfilePin(target.id, pinEnabled ? pin : null, password);
        if (!result.ok) {
          setError(result.error ?? "Could not change the profile lock.");
          return;
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!profile) return;
    setSaving(true);
    const result = await deleteProfile(profile.id, unlock);
    setSaving(false);
    if (!result.ok) {
      setConfirmDelete(false);
      setError(result.error ?? "Could not delete the profile.");
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={titleId}
      testId="profile-editor"
      overlayClassName="flex items-start justify-center sm:items-center sm:p-6"
      className="w-full max-w-3xl animate-rise-in bg-[#181818] shadow-2xl ring-1 ring-white/10 sm:rounded-2xl"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-7">
        <h2 id={titleId} className="text-xl font-semibold sm:text-2xl">
          {mode === "create" ? "Add profile" : "Edit profile"}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="grid gap-6 px-5 py-5 sm:grid-cols-[180px_1fr] sm:px-7">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            {avatar.kind === "upload" && avatar.preview && avatar.crop ? (
              <div className="h-[140px] w-[140px] overflow-hidden rounded-xl bg-black ring-2 ring-white/20" data-testid="avatar-preview">
                <CropPreview url={avatar.preview} crop={avatar.crop} size={140} />
              </div>
            ) : (
              <span data-testid="avatar-preview" data-avatar={previewAvatar}>
                <ProfileAvatar avatar={previewAvatar} name={name || "New profile"} size={140} className="rounded-xl ring-2 ring-white/20" />
              </span>
            )}
            {isKids && <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-amber-400 to-pink-500 px-2.5 py-0.5 text-xs font-bold text-black">KIDS</span>}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            className="sr-only"
            data-testid="avatar-file"
            aria-label="Upload a photo"
            onChange={(e) => {
              chooseFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="mt-2 flex items-center gap-2 rounded-full border border-white/25 px-4 py-1.5 text-sm hover:border-white hover:bg-white/5"
          >
            <Upload className="h-4 w-4" /> Upload photo
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor={nameId} className="mb-1.5 block text-sm text-netflix-light-gray">Name</label>
            <input
              id={nameId}
              data-autofocus
              value={name}
              maxLength={30}
              onChange={(e) => setName(e.target.value)}
              placeholder="Profile name"
              className="w-full rounded-md bg-[#2a2a2a] px-4 py-2.5 text-white ring-1 ring-white/10 placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/60"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={isKids}
                data-testid="profile-kids"
                onChange={(e) => {
                  setIsKids(e.target.checked);
                  if (e.target.checked && maturity === "all") setMaturity("kids");
                  if (!e.target.checked) setMaturity("all");
                }}
                className="h-5 w-5 accent-netflix-red"
              />
              Kids profile
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-netflix-light-gray">Maturity</span>
              <select
                value={maturity}
                data-testid="profile-maturity"
                onChange={(e) => setMaturity(e.target.value as MaturityLevel)}
                className="rounded-md bg-[#2a2a2a] px-3 py-1.5 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-white/60"
              >
                {levels.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-netflix-gray">
            {MATURITY_LEVELS.find((l) => l.value === maturity)?.description}. Titles without a known rating are hidden on restricted profiles.
          </p>

          <div className="rounded-lg bg-white/[0.04] p-3 ring-1 ring-white/10">
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" checked={pinEnabled} data-testid="profile-pin-toggle" onChange={(e) => setPinEnabled(e.target.checked)} className="h-5 w-5 accent-netflix-red" />
              <Lock className="h-4 w-4 text-netflix-light-gray" /> Require a 4-digit PIN to open this profile
            </label>
            {pinEnabled && (
              <div className="mt-3 flex items-center gap-3">
                <label htmlFor={pinId} className="text-sm text-netflix-light-gray">{profile?.hasPin ? "New PIN (leave empty to keep)" : "PIN"}</label>
                <input
                  id={pinId}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={pin}
                  data-testid="profile-pin"
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  className="w-24 rounded-md bg-[#2a2a2a] px-3 py-1.5 text-center tracking-[0.5em] ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-white/60"
                />
              </div>
            )}
          </div>

          {passwordRequired && (
            <div>
              <label htmlFor={passwordId} className="mb-1.5 block text-sm text-netflix-light-gray">
                Account password <span className="text-netflix-gray">— required to change maturity settings or a profile lock</span>
              </label>
              <input
                id={passwordId}
                type="password"
                autoComplete="current-password"
                value={password}
                data-testid="profile-password"
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md bg-[#2a2a2a] px-4 py-2.5 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-white/60"
              />
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/10 px-5 py-4 sm:px-7">
        {avatar.kind === "upload" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-medium">Position your photo</h3>
              <button type="button" onClick={() => setAvatar({ kind: "keep" })} className="text-sm text-netflix-light-gray hover:text-white">
                Back to avatars
              </button>
            </div>
            <AvatarCropper
              file={avatar.file}
              onChange={(crop, preview) => setAvatar((a) => (a.kind === "upload" ? { ...a, crop, preview } : a))}
            />
          </div>
        ) : (
          <div>
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1 row-scroll" role="tablist" aria-label="Avatar collections">
              {[{ id: "all", label: "All" }, ...AVATAR_COLLECTIONS].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={collection === c.id}
                  onClick={() => setCollection(c.id)}
                  className={cn(
                    "shrink-0 rounded-full px-3.5 py-1.5 text-sm transition",
                    collection === c.id ? "bg-white text-black" : "bg-white/10 text-white/80 hover:bg-white/20"
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="grid max-h-[260px] grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-3 overflow-y-auto p-1" role="radiogroup" aria-label="Avatars" data-testid="avatar-grid">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/30 text-xs text-white/70 hover:border-white hover:text-white"
              >
                <ImagePlus className="h-5 w-5" /> Photo
              </button>
              {avatars.map((a) => {
                const selected = selectedBuiltin === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={a.label}
                    title={a.label}
                    data-avatar-id={a.id}
                    onClick={() => setAvatar({ kind: "builtin", id: a.id })}
                    className={cn(
                      "relative aspect-square overflow-hidden rounded-lg transition motion-safe:hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
                      selected ? "ring-[3px] ring-white" : "opacity-85 hover:opacity-100"
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG */}
                    <img src={a.src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    {selected && (
                      <span className="absolute right-1 top-1 rounded-full bg-white p-0.5 text-black">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mx-5 mb-2 rounded-md bg-red-500/10 px-4 py-2 text-sm text-red-300 ring-1 ring-red-500/30 sm:mx-7" data-testid="profile-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-5 py-4 sm:px-7">
        {mode === "edit" && canDelete && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
            data-testid="profile-delete"
          >
            <Trash2 className="h-4 w-4" /> Delete profile
          </button>
        )}
        <div className="ml-auto flex gap-3">
          <button type="button" onClick={onClose} className="rounded-md border border-white/25 px-5 py-2 text-sm font-medium hover:border-white">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            data-testid="profile-save"
            className="rounded-md bg-white px-6 py-2 text-sm font-semibold text-black hover:bg-white/85 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {confirmDelete && profile && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-6 sm:rounded-2xl" role="alertdialog" aria-labelledby={`${titleId}-del`}>
          <div className="max-w-sm rounded-xl bg-[#232323] p-6 text-center ring-1 ring-white/10">
            <h3 id={`${titleId}-del`} className="text-lg font-semibold">Delete “{profile.name}”?</h3>
            <p className="mt-2 text-sm text-netflix-light-gray">Its My List, viewing history and preferences will be removed. This can&apos;t be undone.</p>
            <div className="mt-5 flex justify-center gap-3">
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md border border-white/25 px-5 py-2 text-sm">Keep profile</button>
              <button type="button" onClick={() => void remove()} disabled={saving} data-testid="profile-delete-confirm" className="rounded-md bg-netflix-red px-5 py-2 text-sm font-semibold hover:bg-netflix-red-hover">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Shows the chosen crop of a local image. */
function CropPreview({ url, crop, size }: { url: string; crop: CropRect; size: number }) {
  const scale = size / crop.size;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local object URL
    <img
      src={url}
      alt="Selected photo"
      className="max-w-none origin-top-left"
      style={{ transform: `translate(${-crop.x * scale}px, ${-crop.y * scale}px) scale(${scale})` }}
    />
  );
}
