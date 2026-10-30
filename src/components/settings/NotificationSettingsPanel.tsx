"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { useAppStore, useNotificationPreferences } from "@/lib/store";
import { REGION_OPTIONS, regionFromLocale, type NotificationPreferences } from "@/lib/notifications/preferences";
import { disableBrowserNotifications, enableBrowserNotifications } from "@/lib/notifications/browser";
import { useNotifications } from "@/components/notifications/NotificationsProvider";
import { Notice, Pill, api } from "@/components/setup/ui";

const CATEGORIES: Array<[keyof NotificationPreferences, string, string]> = [
  ["episodes", "New episodes", "Series in My List, ones you are watching, and series you follow."],
  ["seasons", "New seasons", "When a followed series announces a season, and when it starts."],
  ["digital", "Digital releases & streaming", "Films in My List released to buy/rent digitally or added to a streaming service in your region, plus a few popular new releases that match your taste."],
  ["physical", "Blu-ray & DVD releases", "Disc releases in your region."],
  ["trending", "Trending titles", "Occasional popular titles close to what you watch."],
  ["recommendations", "Recommendations", "Based on what you watched and saved."],
  ["service", "Service announcements", "Problems the server owner should know about (owners and administrators only)."],
];

function Switch({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-netflix-red" data-testid={id} />
      <span>
        {label}
        {hint && <span className="block text-xs text-netflix-gray">{hint}</span>}
      </span>
    </label>
  );
}

interface JobStatus {
  intervalHours: number;
  lastSuccessAt?: string;
  lastRunAt?: string;
  failures: number;
  lastError?: string;
  lastSummary?: string;
}

interface ChecksStatus {
  tmdb: boolean;
  disabled: boolean;
  jobs: Record<string, JobStatus>;
  tracked: { series: number; films: number };
}

/** Owner/administrator view of the background checks, with "check now". */
function BackgroundChecks() {
  const [data, setData] = useState<ChecksStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<ChecksStatus>("/api/notifications/status");
    if (r.ok) setData(r.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted
    void load();
  }, [load]);
  if (!data) return null;
  const run = async (job: string) => {
    setBusy(job);
    setMessage(null);
    const { ok, data: r } = await api<{ ran: boolean; reason?: string; state?: JobStatus }>("/api/notifications/status", { method: "POST", body: { job } });
    setBusy(null);
    setMessage(!ok ? r.error ?? "Could not run the check." : r.ran ? `${job}: ${r.state?.lastError ? `failed (${r.state.lastError})` : r.state?.lastSummary ?? "done"}` : r.reason ?? "Not run.");
    void load();
  };
  const labels: Record<string, string> = { series: "New episodes & seasons", releases: "Releases & streaming", trending: "Trending", recommendations: "Recommendations", service: "Service checks", cleanup: "Clean-up" };
  return (
    <div className="mt-6 border-t border-white/10 pt-5" data-testid="notification-jobs">
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-netflix-gray">Background checks (server)</h3>
      <p className="mb-3 text-xs text-netflix-gray">
        Run inside the Notflix server. {data.disabled ? "Turned off with NOTFLIX_NOTIFICATIONS." : data.tmdb ? `Tracking ${data.tracked.series} series and ${data.tracked.films} film/region pairs.` : "Need a TMDB key."}
      </p>
      <ul className="space-y-1.5 text-sm">
        {Object.entries(data.jobs).map(([name, j]) => (
          <li key={name} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {labels[name] ?? name} <span className="text-xs text-netflix-gray">every {j.intervalHours} h</span>{" "}
              {j.failures > 0 ? <Pill tone="warn">failing ×{j.failures}</Pill> : j.lastSuccessAt ? <Pill tone="ok">ok</Pill> : <Pill tone="muted">not run yet</Pill>}
              <span className="block text-xs text-netflix-gray">{j.failures > 0 ? j.lastError : j.lastSuccessAt ? `${new Date(j.lastSuccessAt).toLocaleString()} · ${j.lastSummary ?? ""}` : ""}</span>
            </span>
            <button type="button" disabled={busy !== null} onClick={() => void run(name)} className="flex items-center gap-1 rounded px-2 py-1 text-xs ring-1 ring-white/15 hover:bg-white/10 disabled:opacity-50">
              {busy === name && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />} Check now
            </button>
          </li>
        ))}
      </ul>
      {message && <p className="mt-2 text-xs text-netflix-light-gray" role="status">{message}</p>}
    </div>
  );
}

/** Notification preferences of the profile in use (saved per profile, server-side). */
export function NotificationSettingsPanel() {
  const prefs = useNotificationPreferences();
  const update = useAppStore((s) => s.updatePreferences);
  const profileId = useAppStore((s) => s.activeProfileId);
  const role = useAppStore((s) => s.user?.role);
  const { browser, pushActive, recheckBrowser } = useNotifications();
  const [busy, setBusy] = useState(false);
  const [browserMessage, setBrowserMessage] = useState<{ tone: "ok" | "warn" | "info"; text: string } | null>(null);
  const set = (patch: Partial<NotificationPreferences>) => update({ notifications: { ...prefs, ...patch } });

  // Viewing the settings re-checks the browser's permission (it may have changed meanwhile).
  useEffect(() => {
    void recheckBrowser();
  }, [recheckBrowser]);

  if (!profileId) return null;

  const toggleBrowser = async (on: boolean) => {
    setBusy(true);
    setBrowserMessage(null);
    if (on) {
      const r = await enableBrowserNotifications();
      if (r.enabled) set({ browser: true });
      setBrowserMessage({ tone: r.enabled ? (r.push ? "ok" : "info") : "warn", text: r.message });
    } else {
      await disableBrowserNotifications();
      set({ browser: false });
      setBrowserMessage({ tone: "info", text: "Browser notifications are off for this profile. Notifications inside Notflix continue." });
    }
    await recheckBrowser();
    setBusy(false);
  };

  const state = browser?.state;
  const blocked = prefs.browser && (state === "denied" || state === "default" || state === "insecure" || state === "unsupported");
  const browserRegion = typeof navigator !== "undefined" ? regionFromLocale(navigator.language) : "";

  return (
    <section id="notifications" className="rounded-panel bg-surface p-6 ring-1 ring-line" data-testid="notification-settings">
      <h2 className="mb-1 flex items-center gap-2 text-xl font-semibold">
        <BellRing className="h-5 w-5" aria-hidden /> Notifications
      </h2>
      <p className="mb-5 text-sm text-netflix-light-gray">For this profile only. Notifications always appear under the bell; browser notifications are optional.</p>

      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-netflix-gray">Notify me about</h3>
      <div className="space-y-2.5">
        {CATEGORIES.filter(([key]) => key !== "service" || role === "owner" || role === "admin").map(([key, label, hint]) => (
          <Switch key={key} id={`notify-${key}`} label={label} hint={hint} checked={Boolean(prefs[key])} onChange={(v) => set({ [key]: v } as Partial<NotificationPreferences>)} />
        ))}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-netflix-light-gray">
          Release region
          <select value={prefs.region} onChange={(e) => set({ region: e.target.value })} className="mt-1 w-full rounded bg-[#333] px-3 py-2 text-white" data-testid="notify-region">
            <option value="">Automatic{browserRegion ? ` (${browserRegion})` : " (US)"}</option>
            {REGION_OPTIONS.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
            {prefs.region && !REGION_OPTIONS.some(([c]) => c === prefs.region) && <option value={prefs.region}>{prefs.region}</option>}
          </select>
          <span className="mt-1 block text-xs text-netflix-gray">Release dates and streaming services differ by country.</span>
        </label>
        <label className="text-sm text-netflix-light-gray">
          Trending & recommendations
          <select value={prefs.digest} onChange={(e) => set({ digest: e.target.value as NotificationPreferences["digest"] })} className="mt-1 w-full rounded bg-[#333] px-3 py-2 text-white" data-testid="notify-digest">
            <option value="daily">One daily summary</option>
            <option value="instant">Each title separately (a few per day at most)</option>
          </select>
        </label>
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-netflix-gray">Browser notifications</h3>
      <Switch
        id="notify-browser"
        label="Enable browser notifications"
        hint="Pop-ups from your browser, also when Notflix is in the background. Your browser asks for permission once."
        checked={prefs.browser && state === "granted"}
        disabled={busy}
        onChange={(v) => void toggleBrowser(v)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-netflix-gray" data-testid="browser-notify-state">
        <span>This browser:</span>
        {state === "granted" ? (
          <Pill tone="ok">allowed</Pill>
        ) : state === "denied" ? (
          <Pill tone="error">blocked</Pill>
        ) : state === "insecure" ? (
          <Pill tone="warn">needs HTTPS or localhost</Pill>
        ) : state === "unsupported" ? (
          <Pill tone="muted">not supported</Pill>
        ) : (
          <Pill tone="muted">not asked yet</Pill>
        )}
        {prefs.browser && state === "granted" && <span>{pushActive ? "· background delivery on" : "· shown while Notflix is open"}</span>}
        {busy && <Loader2 className="h-3 w-3 animate-spin" aria-label="Working" />}
      </div>
      {browserMessage && (
        <Notice tone={browserMessage.tone} className="mt-3">
          {browserMessage.text}
        </Notice>
      )}
      {!browserMessage && blocked && browser && (
        <Notice tone="warn" className="mt-3">
          {state === "default" ? "Permission for this browser was withdrawn. Turn the switch on again to be asked once more." : browser.message}
        </Notice>
      )}
      <p className="mt-3 text-xs leading-relaxed text-netflix-gray">
        Windows (or macOS) notification settings and Focus / Do Not Disturb can still hide them; websites cannot see those settings.
      </p>

      <div className="mt-4 space-y-2">
        <Switch
          id="notify-quiet"
          label={`Quiet hours for browser notifications (${prefs.quietHours.start}–${prefs.quietHours.end})`}
          hint="Held back until the quiet hours end; they still appear under the bell right away."
          checked={prefs.quietHours.enabled}
          onChange={(v) => set({ quietHours: { ...prefs.quietHours, enabled: v } })}
        />
        {prefs.quietHours.enabled && (
          <div className="flex flex-wrap gap-3 pl-7 text-sm text-netflix-light-gray">
            <label>
              From{" "}
              <input type="time" value={prefs.quietHours.start} onChange={(e) => e.target.value && set({ quietHours: { ...prefs.quietHours, start: e.target.value } })} className="ml-1 rounded bg-[#333] px-2 py-1 text-white" />
            </label>
            <label>
              to{" "}
              <input type="time" value={prefs.quietHours.end} onChange={(e) => e.target.value && set({ quietHours: { ...prefs.quietHours, end: e.target.value } })} className="ml-1 rounded bg-[#333] px-2 py-1 text-white" />
            </label>
            <span className="self-center text-xs text-netflix-gray">{prefs.timeZone || "UTC"}</span>
          </div>
        )}
      </div>

      {(role === "owner" || role === "admin") && <BackgroundChecks />}
    </section>
  );
}
