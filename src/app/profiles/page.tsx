"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Lock, Pencil, Plus } from "lucide-react";
import { BrandLoader, NotflixWordmark } from "@/components/brand/Logo";
import { useAppStore } from "@/lib/store";
import { selectProfile } from "@/lib/profile-client";
import { disableBrowserNotifications } from "@/lib/notifications/browser";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";
import { ProfileEditor } from "@/components/profile/ProfileEditor";
import { PinDialog } from "@/components/profile/PinDialog";
import { isRestricted, profileMaturity } from "@/lib/maturity";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/cn";

const MAX_PROFILES = 8;

const TILE_BUTTON =
  "group flex w-[132px] flex-col items-center gap-3 rounded-avatar outline-none [-webkit-tap-highlight-color:transparent] sm:w-[148px] md:w-[168px]";
const TILE_FRAME =
  "relative block aspect-square w-full overflow-hidden rounded-avatar shadow-card ring-0 ring-white transition-[transform,box-shadow] duration-300 ease-cinematic group-hover:ring-[3px] group-focus-visible:ring-[3px] motion-safe:group-hover:-translate-y-1.5 motion-safe:group-hover:scale-[1.04] motion-safe:group-focus-visible:-translate-y-1.5 motion-safe:group-focus-visible:scale-[1.04] group-active:scale-[0.98] group-hover:shadow-glow group-focus-visible:shadow-glow";
const TILE_NAME =
  "max-w-full truncate text-sm text-ink-3 transition-colors duration-200 group-hover:text-ink group-focus-visible:text-ink md:text-base";

export default function ProfilesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ProfilesScreen />
    </Suspense>
  );
}

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <BrandLoader label="Loading profiles" />
    </div>
  );
}

type Editing = { mode: "create" } | { mode: "edit"; profile: UserProfile; unlockPin?: string };
type PinPrompt = { profile: UserProfile; purpose: "select" | "edit" };

function ProfilesScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const profiles = useAppStore((s) => s.profiles);
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const hydrateUserState = useAppStore((s) => s.hydrateUserState);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const [loading, setLoading] = useState(true);
  const [managing, setManaging] = useState(params.get("manage") === "1");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pinPrompt, setPinPrompt] = useState<PinPrompt | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const next = params.get("next");
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/browse";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        if (!res.ok) {
          router.replace("/");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setUser(data.user);
        hydrateUserState(data.state);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router, setUser, hydrateUserState]);

  const enter = async (profile: UserProfile, pin?: string): Promise<string | null> => {
    setBusyId(profile.id);
    setError(null);
    const result = await selectProfile(profile.id, pin);
    setBusyId(null);
    if (!result.ok) {
      if (result.code === "pin_required" && !pin) {
        setPinPrompt({ profile, purpose: "select" });
        return null;
      }
      if (!pin) setError(result.error ?? "Could not open that profile.");
      return result.error ?? "Could not open that profile.";
    }
    setPinPrompt(null);
    router.push(destination);
    return null;
  };

  const onProfileClick = (profile: UserProfile) => {
    if (managing) {
      if (profile.hasPin && profile.id !== activeProfileId) setPinPrompt({ profile, purpose: "edit" });
      else setEditing({ mode: "edit", profile });
      return;
    }
    if (profile.hasPin && profile.id !== activeProfileId) setPinPrompt({ profile, purpose: "select" });
    else void enter(profile);
  };

  if (loading && profiles.length === 0) return <Spinner />;

  const editingProfile = editing?.mode === "edit" ? profiles.find((p) => p.id === editing.profile.id) ?? editing.profile : undefined;

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-canvas">
      {/* Stage lighting: a soft red bloom above the profiles and a gentle vignette. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgba(229,9,20,0.16),transparent_70%),radial-gradient(120%_80%_at_50%_120%,rgba(0,0,0,0.6),transparent_60%)]" aria-hidden />
      <header className="relative z-10 flex items-center justify-between px-5 py-5 md:px-12 md:py-7">
        <NotflixWordmark title="Notflix" className="h-7 w-auto md:h-8" />
        {user && (
          <button
            type="button"
            onClick={async () => {
              await disableBrowserNotifications();
              await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
              useAppStore.getState().logoutLocal();
              window.location.href = "/";
            }}
            className="focus-ring rounded-control px-3 py-2 text-sm text-ink-3 transition-colors hover:text-ink"
          >
            Sign out
          </button>
        )}
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 pb-24 pt-4 md:pb-32">
        <div className="mb-10 text-center md:mb-14">
          <h1 className="text-[32px] font-semibold tracking-tight text-ink md:text-5xl">{managing ? "Manage profiles" : "Who\u2019s watching?"}</h1>
          <p className="mt-3 text-sm text-ink-3 md:text-base">{managing ? "Choose a profile to edit its name, avatar and settings." : "Choose your profile to continue."}</p>
        </div>

        <ul className="flex max-w-[1100px] flex-wrap justify-center gap-x-6 gap-y-8 sm:gap-x-8 md:gap-x-10" aria-label="Profiles">
          {profiles.map((profile, i) => {
            const restricted = isRestricted(profileMaturity(profile));
            return (
              <li key={profile.id} className="flex justify-center motion-safe:animate-[riseIn_420ms_var(--ease-cinematic)_both]" style={{ animationDelay: `${40 + i * 45}ms` }}>
                <button
                  type="button"
                  onClick={() => onProfileClick(profile)}
                  disabled={busyId !== null}
                  data-testid="profile-tile"
                  data-profile-name={profile.name}
                  aria-label={`${managing ? "Edit" : "Open"} ${profile.name}${profile.hasPin ? ", PIN protected" : ""}${restricted ? ", kids profile" : ""}`}
                  className={TILE_BUTTON}
                >
                  <span className={cn(TILE_FRAME, busyId === profile.id && "animate-pulse")}>
                    <ProfileAvatar avatar={profile.avatar} name={profile.name} size={168} className="h-full w-full rounded-[inherit]" decorative />
                    {managing && (
                      <span className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/55 backdrop-blur-[1px]">
                        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/70 bg-black/40">
                          <Pencil className="h-5 w-5" />
                        </span>
                      </span>
                    )}
                    {restricted && (
                      <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white ring-1 ring-white/20 backdrop-blur" aria-hidden>
                        Kids
                      </span>
                    )}
                    {profile.hasPin && (
                      <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 ring-1 ring-white/20 backdrop-blur" aria-hidden>
                        <Lock className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </span>
                  <span className={TILE_NAME}>{profile.name}</span>
                </button>
              </li>
            );
          })}
          {profiles.length < MAX_PROFILES && (
            <li className="flex justify-center motion-safe:animate-[riseIn_420ms_var(--ease-cinematic)_both]" style={{ animationDelay: `${40 + profiles.length * 45}ms` }}>
              <button type="button" onClick={() => setEditing({ mode: "create" })} data-testid="profile-add" className={TILE_BUTTON}>
                <span className={cn(TILE_FRAME, "flex items-center justify-center bg-surface-2 ring-1 ring-inset ring-line-strong")}>
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-ink-2 transition-colors group-hover:bg-white group-hover:text-black group-focus-visible:bg-white group-focus-visible:text-black md:h-16 md:w-16">
                    <Plus className="h-7 w-7 md:h-8 md:w-8" />
                  </span>
                </span>
                <span className={TILE_NAME}>Add profile</span>
              </button>
            </li>
          )}
        </ul>

        {error && (
          <p role="alert" className="mt-8 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => setManaging(!managing)}
          data-testid="profiles-manage"
          className={cn(
            "focus-ring mt-12 inline-flex items-center gap-2.5 rounded-full px-6 py-2.5 text-sm font-medium tracking-wide transition-colors md:mt-16 md:text-[15px]",
            managing ? "bg-white text-black hover:bg-white/85" : "border border-line-strong text-ink-2 hover:border-white/60 hover:bg-white/[0.06] hover:text-ink"
          )}
        >
          {managing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          {managing ? "Done" : "Manage Profiles"}
        </button>
      </main>

      {editing && (
        <ProfileEditor
          mode={editing.mode}
          profile={editingProfile}
          unlockPin={editing.mode === "edit" ? editing.unlockPin : undefined}
          canDelete={profiles.length > 1}
          onClose={() => setEditing(null)}
        />
      )}
      {pinPrompt && (
        <PinDialog
          profile={pinPrompt.profile}
          purpose={pinPrompt.purpose === "edit" ? "Enter the PIN to edit this profile." : "Enter your PIN to open this profile."}
          onClose={() => setPinPrompt(null)}
          onSubmit={async (pin) => {
            if (pinPrompt.purpose === "select") return enter(pinPrompt.profile, pin);
            // Editing another protected profile: the PIN is checked by each change the editor makes.
            if (!/^\d{4}$/.test(pin)) return "Enter 4 digits.";
            setEditing({ mode: "edit", profile: pinPrompt.profile, unlockPin: pin });
            setPinPrompt(null);
            return null;
          }}
        />
      )}
    </div>
  );
}
