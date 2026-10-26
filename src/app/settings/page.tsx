"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { ProfilePreferencesPanel } from "@/components/settings/ProfilePreferencesPanel";
import { AccountPanel } from "@/components/settings/AccountPanel";
import { AccountsAdminPanel } from "@/components/settings/AccountsAdminPanel";
import { DebridPanel, HardwarePanel, MetadataPanel, ServerPanel, SummaryList, type InstallSummary } from "@/components/setup/ConfigPanels";
import { Button, Notice, Toggle, api, fieldClass } from "@/components/setup/ui";
import type { AppSettings } from "@/lib/types";

function Card({ title, description, children, testId }: { title: string; description?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-panel bg-surface p-6 ring-1 ring-line" data-testid={testId}>
      <h2 className="text-xl font-semibold">{title}</h2>
      {description && <p className="mb-5 mt-1 text-sm leading-relaxed text-netflix-light-gray">{description}</p>}
      {!description && <div className="mb-4" />}
      {children}
    </section>
  );
}

const LANGUAGES: Array<[string, string]> = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["ru", "Russian"], ["nl", "Dutch"], ["sv", "Swedish"],
];

/** Server-wide playback defaults (profiles can override audio/subtitle preferences). */
function PlaybackDefaults() {
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ settings: AppSettings }>("/api/settings/sync").then(({ ok, data }) => ok && setForm(data.settings));
  }, []);
  if (!form) return <p className="text-sm text-netflix-gray">Loading…</p>;
  const set = (patch: Partial<AppSettings>) => setForm((f) => ({ ...f!, ...patch }));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await api<{ settings: AppSettings; engineUpdated: boolean }>("/api/settings/sync", { method: "POST", body: form });
    setBusy(false);
    if (!ok) return setMessage({ tone: "error", text: data.error ?? "Could not save." });
    setForm(data.settings);
    updateSettings(data.settings);
    setMessage({ tone: "ok", text: "Playback settings saved." });
  };

  const select = (id: string, label: string, value: string | number, options: Array<[string | number, string]>, onChange: (v: string) => void) => (
    <label htmlFor={id} className="text-sm text-netflix-light-gray">
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${fieldClass} mt-1`}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {select("pb-res", "Maximum resolution", form.maxResolution ?? 2160, [[2160, "4K (2160p)"], [1440, "1440p"], [1080, "1080p"], [720, "720p"], [480, "480p"]], (v) => set({ maxResolution: Number(v) }))}
        {select("pb-quality", "Quality", form.playbackQuality ?? "best", [["best", "Best available"], ["balanced", "Balanced (smaller files)"], ["data-saver", "Data saver (720p)"]], (v) => set({ playbackQuality: v as AppSettings["playbackQuality"] }))}
        {select("pb-audio", "Default audio language", form.audioLanguage ?? "en", LANGUAGES, (v) => set({ audioLanguage: v }))}
        {select("pb-subs", "Default subtitles", form.subtitleLanguage ?? "off", [["off", "Off"], ...LANGUAGES], (v) => set({ subtitleLanguage: v }))}
        {select("pb-buffer", "Buffering", form.bufferProfile ?? "auto", [["auto", "Automatic (by resolution)"], ["low", "Low (fast start, less memory)"], ["balanced", "Balanced"], ["high", "High (unstable connections)"]], (v) => set({ bufferProfile: v as AppSettings["bufferProfile"] }))}
      </div>
      <div className="space-y-1">
        <Toggle id="pb-direct" label="Play compatible files directly (no conversion)" checked={form.directPlay ?? true} onChange={(v) => set({ directPlay: v })} />
        <Toggle id="pb-surround" label="Keep 5.1 surround when audio must be converted" checked={form.surroundAudio ?? false} onChange={(v) => set({ surroundAudio: v })} />
        <Toggle id="pb-diag" label="Stream information panel (right-click the player)" checked={form.streamDiagnostics ?? true} onChange={(v) => set({ streamDiagnostics: v })} />
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href="/settings/playback-test" className="rounded-md px-4 py-2.5 text-sm text-netflix-light-gray ring-1 ring-white/15 hover:bg-white/10 hover:text-white">
          Playback self-test
        </Link>
        <Button busy={busy} onClick={() => void save()}>
          <span data-testid="save-playback">Save playback settings</span>
        </Button>
      </div>
    </div>
  );
}

function SystemStatus() {
  const [summary, setSummary] = useState<InstallSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { ok, data } = await api<InstallSummary>("/api/config/summary");
    if (ok) setSummary(data);
    else setError(data.error ?? "Could not load.");
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
    void load();
  }, [load]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!summary) return <p className="text-sm text-netflix-gray">Loading…</p>;
  const missing = summary.requirements.filter((r) => !r.ok);
  return (
    <div className="space-y-4" data-testid="engine-status">
      <SummaryList summary={summary} />
      {missing.map((r) => (
        <Notice key={r.id} tone="error">
          <span className="text-white">{r.label}:</span> {r.detail}
        </Notice>
      ))}
      {missing.length === 0 && <Notice tone="ok">Everything Notflix needs is in place.</Notice>}
    </div>
  );
}

const OWNER_SECTIONS = [
  { id: "system", label: "System" },
  { id: "server", label: "Server & storage" },
  { id: "metadata", label: "Metadata" },
  { id: "debrid", label: "Real-Debrid" },
  { id: "hardware", label: "Hardware" },
  { id: "playback", label: "Playback" },
  { id: "accounts", label: "Accounts" },
] as const;

export default function SettingsPage() {
  const user = useAppStore((s) => s.user);
  const [canManage, setCanManage] = useState<boolean | null>(null);

  useEffect(() => {
    void api<{ canManageServer: boolean }>("/api/settings/sync").then(({ ok, data }) => setCanManage(ok && data.canManageServer));
  }, []);
  const isOwner = canManage === true || user?.role === "owner";
  const isAdmin = isOwner || user?.role === "admin";

  return (
    <div className="min-h-screen bg-netflix-black px-4 py-8 md:px-12 lg:px-16">
      <Link href={user ? "/browse" : "/"} className="mb-8 inline-flex items-center gap-2 text-sm hover:underline">
        <ArrowLeft className="h-4 w-4" />
        {user ? "Back to Browse" : "Back to Sign In"}
      </Link>

      <h1 className="mb-2 text-3xl font-semibold">Settings</h1>
      <p className="mb-8 max-w-3xl text-netflix-light-gray">
        Your account and profile preferences{isOwner ? ", plus everything about this Notflix server" : ""}. Credentials are stored on the server and are never
        sent back to a browser.
      </p>

      {isOwner && (
        <nav aria-label="Settings sections" className="mx-auto mb-8 flex max-w-3xl flex-wrap gap-2 text-sm">
          {OWNER_SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="rounded-full bg-white/10 px-3 py-1 hover:bg-white/20">
              {s.label}
            </a>
          ))}
        </nav>
      )}

      <div className="mx-auto max-w-3xl space-y-8">
        <AccountPanel />
        <ProfilePreferencesPanel />

        {canManage === false && !isAdmin && (
          <section className="rounded border border-white/10 p-6 text-sm text-netflix-light-gray" data-testid="server-settings-locked">
            Server settings (Real-Debrid, TMDB, hardware and storage) are managed by the server&apos;s owner.
          </section>
        )}

        {isOwner && (
          <>
            <div id="system">
              <Card title="System" description="How this server is set up right now.">
                <SystemStatus />
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5">
                  <p className="max-w-md text-sm text-netflix-light-gray">
                    Walk through the setup steps again (server, TMDB, Real-Debrid, graphics card). Accounts and settings are kept; new keys are checked before
                    they replace the old ones.
                  </p>
                  <Link
                    href="/settings/wizard"
                    data-testid="rerun-wizard"
                    className="rounded-md bg-white/10 px-4 py-2.5 text-sm font-semibold text-white ring-1 ring-white/15 hover:bg-white/20"
                  >
                    Run the setup wizard again
                  </Link>
                </div>
              </Card>
            </div>
            <div id="server">
              <Card title="Server & storage" description="Network access, port and the disposable media cache.">
                <ServerPanel mode="settings" />
              </Card>
            </div>
            <div id="metadata">
              <Card title="Metadata" testId="metadata-settings">
                <MetadataPanel mode="settings" />
              </Card>
            </div>
            <div id="debrid">
              <Card title="Real-Debrid" testId="debrid-settings">
                <DebridPanel mode="settings" />
              </Card>
            </div>
            <div id="hardware">
              <Card title="Hardware acceleration" testId="hardware-settings">
                <HardwarePanel mode="settings" />
              </Card>
            </div>
            <div id="playback">
              <Card title="Playback" description="Defaults for every account. Each profile can still choose its own audio and subtitle languages." testId="playback-settings">
                <PlaybackDefaults />
              </Card>
            </div>
          </>
        )}

        {isAdmin && (
          <div id="accounts">
            <AccountsAdminPanel />
          </div>
        )}
      </div>
    </div>
  );
}
