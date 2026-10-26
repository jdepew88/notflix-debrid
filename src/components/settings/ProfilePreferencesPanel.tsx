"use client";

import { useAppStore, useActivePreferences } from "@/lib/store";
import { LANGUAGE_OPTIONS, type ProfilePreferences, type SubtitleStyle } from "@/lib/profile-preferences";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";

function Select<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void; testId?: string }) {
  return (
    <label className="text-sm text-netflix-light-gray">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="mt-1 w-full rounded bg-[#333] px-3 py-2 text-white" data-testid={testId}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, hint, checked, onChange, testId }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-netflix-red" data-testid={testId} />
      <span>
        {label}
        {hint && <span className="block text-xs text-netflix-gray">{hint}</span>}
      </span>
    </label>
  );
}

/** Audio, subtitle and autoplay preferences for the active profile (saved per profile, server-side). */
export function ProfilePreferencesPanel() {
  const prefs = useActivePreferences();
  const update = useAppStore((s) => s.updatePreferences);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const profile = useAppStore((s) => s.profiles.find((p) => p.id === s.activeProfileId));
  const set = (patch: Partial<ProfilePreferences>) => update(patch);
  const setStyle = (patch: Partial<SubtitleStyle>) => update({ subtitleStyle: { ...prefs.subtitleStyle, ...patch } });

  if (!activeProfileId) {
    return (
      <section className="rounded-panel bg-surface p-6 ring-1 ring-line">
        <h2 className="mb-2 text-xl font-semibold">Profile preferences</h2>
        <p className="text-sm text-netflix-light-gray">Choose a profile to edit its audio, subtitle and autoplay preferences.</p>
      </section>
    );
  }

  return (
    <section className="rounded-panel bg-surface p-6 ring-1 ring-line" data-testid="profile-preferences">
      <h2 className="mb-1 flex items-center gap-2 text-xl font-semibold">
        Profile preferences
        {profile && (
          <span className="flex items-center gap-2 text-base font-normal text-netflix-light-gray">
            · <ProfileAvatar avatar={profile.avatar} name={profile.name} size={24} className="rounded" decorative /> {profile.name}
          </span>
        )}
      </h2>
      <p className="mb-5 text-sm text-netflix-light-gray">Saved for this profile only. Changes apply immediately — no save button needed.</p>

      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-netflix-gray">Audio</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Preferred language" value={prefs.audioLanguage} options={LANGUAGE_OPTIONS} onChange={(v) => set({ audioLanguage: v })} testId="pref-audio-language" />
        <Select label="Secondary language" value={prefs.secondaryAudioLanguage} options={[["", "None"], ...LANGUAGE_OPTIONS]} onChange={(v) => set({ secondaryAudioLanguage: v })} testId="pref-audio-secondary" />
      </div>
      <div className="mt-3 space-y-2">
        <Toggle label="Prefer the original-language audio" hint="Use the film's original soundtrack when the release has it (your preferred language otherwise)." checked={prefs.preferOriginalAudio} onChange={(v) => set({ preferOriginalAudio: v })} />
        <Toggle label="Prefer surround sound" hint="Pick 5.1/7.1 tracks over stereo when both exist." checked={prefs.preferSurround} onChange={(v) => set({ preferSurround: v })} />
        <Toggle label="Remember my audio & subtitle choice per title" checked={prefs.rememberLanguage} onChange={(v) => set({ rememberLanguage: v })} />
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-netflix-gray">Subtitles</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Subtitle language" value={prefs.subtitleLanguage} options={LANGUAGE_OPTIONS} onChange={(v) => set({ subtitleLanguage: v })} testId="pref-subtitle-language" />
        <Select label="Size" value={prefs.subtitleStyle.size} options={[["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["xlarge", "Extra large"]]} onChange={(v) => setStyle({ size: v })} />
        <Select label="Color" value={prefs.subtitleStyle.color} options={[["white", "White"], ["yellow", "Yellow"], ["cyan", "Cyan"]]} onChange={(v) => setStyle({ color: v })} />
        <Select label="Background" value={prefs.subtitleStyle.background} options={[["none", "None"], ["semi", "Shaded"], ["solid", "Solid"]]} onChange={(v) => setStyle({ background: v })} />
      </div>
      <div className="mt-3 space-y-2">
        <Toggle label="Show subtitles by default" checked={prefs.subtitlesEnabled} onChange={(v) => set({ subtitlesEnabled: v })} testId="pref-subtitles-enabled" />
        <Toggle label="Show forced subtitles" hint="Foreign-language parts only, when the release provides them." checked={prefs.forcedSubtitles} onChange={(v) => set({ forcedSubtitles: v })} />
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-netflix-gray">Autoplay</h3>
      <div className="space-y-2">
        <Toggle label="Autoplay homepage previews" hint="Plays a muted trailer in the featured banner. Off by default; honours your system's reduced-motion setting." checked={prefs.autoplayPreviews} onChange={(v) => set({ autoplayPreviews: v })} testId="pref-autoplay-previews" />
        <Toggle label="Autoplay next episode" checked={prefs.autoplayNextEpisode} onChange={(v) => set({ autoplayNextEpisode: v })} testId="pref-autoplay-next" />
      </div>
    </section>
  );
}
