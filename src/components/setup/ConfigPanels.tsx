"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, Field, Notice, Pill, Toggle, api, fieldClass } from "./ui";

/**
 * Installation settings panels, shared by the first-run wizard (/setup) and the owner's
 * Settings page. Each panel loads and saves its own slice through /api/config/*; credentials are
 * write-only (the server only ever reports whether one is stored).
 */

type Mode = "setup" | "settings";
interface PanelProps {
  mode: Mode;
  /** Called after a successful save (the wizard uses it to move on). */
  onSaved?: () => void;
}

function Loading() {
  return (
    <div className="flex items-center gap-3 py-6 text-sm text-netflix-light-gray">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden /> Loading…
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Server and storage

interface ServerView {
  server: { port: number; allowLan: boolean; hostname: string; reverseProxy: boolean; publicUrl: string; effectiveBindAddress: string };
  storage: { cacheDirectory: string; cacheMaxGiB: number; dataDir: string };
  engine: { port: number };
  listening: { host: string; port: number; pending?: { host: string; port: number; error: string } | null } | null;
  lanAddresses: string[];
}

function isLocalHostname(h: string) {
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/** Waits until the server answers on `origin` (it moves there by itself after a port change). */
async function waitForOrigin(origin: string, timeoutMs = 20_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await fetch(`${origin}/api/health`, { mode: "no-cors", cache: "no-store" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return false;
}

export function ServerPanel({ mode, onSaved }: PanelProps) {
  const [view, setView] = useState<ServerView | null>(null);
  const [form, setForm] = useState({ port: "", hostname: "", allowLan: false, reverseProxy: false, publicUrl: "", cacheDirectory: "", cacheMaxGiB: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<ServerView>("/api/config/server");
    if (!ok) {
      setMessage({ tone: "error", text: data.error ?? "Could not load the server settings." });
      return;
    }
    setView(data);
    setForm({
      port: String(data.server.port),
      hostname: data.server.hostname,
      allowLan: data.server.allowLan,
      reverseProxy: data.server.reverseProxy,
      publicUrl: data.server.publicUrl,
      cacheDirectory: data.storage.cacheDirectory,
      cacheMaxGiB: String(data.storage.cacheMaxGiB),
    });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
    void load();
  }, [load]);

  if (!view) return message ? <Notice tone="error">{message.text}</Notice> : <Loading />;

  const leavingLan = view.server.allowLan && !form.allowLan && typeof window !== "undefined" && !isLocalHostname(window.location.hostname);

  const save = async () => {
    setBusy(true);
    setErrors({});
    setMessage(null);
    const body = {
      port: Number(form.port),
      hostname: form.hostname.trim(),
      allowLan: form.allowLan,
      reverseProxy: form.reverseProxy,
      publicUrl: form.reverseProxy ? form.publicUrl.trim() : "",
      cacheDirectory: form.cacheDirectory.trim(),
      cacheMaxGiB: Number(form.cacheMaxGiB),
    };
    const { ok, data } = await api<ServerView & { applied?: { listenChanged: boolean; restartRequired: string[] } }>("/api/config/server", { method: "PUT", body });
    if (!ok) {
      setErrors(data.errors ?? {});
      setMessage({ tone: "error", text: data.error ?? "Could not save." });
      setBusy(false);
      return;
    }
    setView(data);
    const notes = data.applied?.restartRequired ?? [];
    // A new port: the server moves there by itself; follow it.
    if (data.applied?.listenChanged && typeof window !== "undefined" && String(body.port) !== window.location.port) {
      const origin = `${window.location.protocol}//${window.location.hostname}:${body.port}`;
      setMessage({ tone: "warn", text: `Moving to port ${body.port}…` });
      if (await waitForOrigin(origin)) {
        window.location.href = `${origin}${window.location.pathname}${window.location.search}`;
        return;
      }
      setMessage({ tone: "error", text: `Notflix did not answer on port ${body.port}. It stays on the old port; check that no other program uses the new one.` });
      setBusy(false);
      return;
    }
    setBusy(false);
    setMessage({ tone: notes.length ? "warn" : "ok", text: notes.length ? `Saved. ${notes.join(" ")}` : "Saved." });
    onSaved?.();
  };

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const port = Number(form.port) || view.server.port;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="srv-host" label="Server name or address (optional)" error={errors.hostname} hint="How other devices should reach this computer, e.g. media-pc.local or 192.168.1.20. Used for links only.">
          <input id="srv-host" className={fieldClass} value={form.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="media-pc.local" autoComplete="off" aria-invalid={Boolean(errors.hostname)} />
        </Field>
        <Field id="srv-port" label="Web port" error={errors.port} hint={`Notflix answers on this port. The media engine uses ${view.engine.port} on this computer only.`}>
          <input id="srv-port" className={fieldClass} inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "").slice(0, 5) })} aria-invalid={Boolean(errors.port)} />
        </Field>
      </div>

      <div className="space-y-3 rounded-md bg-white/[0.03] p-3 ring-1 ring-white/10">
        <Toggle
          id="srv-lan"
          label="Allow other devices on my local network"
          checked={form.allowLan}
          onChange={(v) => set({ allowLan: v })}
          description={
            form.allowLan
              ? `Phones, TVs and other computers on your network can open Notflix${view.lanAddresses.length ? ` at ${view.lanAddresses.map((a) => `http://${a}:${port}`).join(" or ")}` : ""}. Windows may ask you to allow Node.js through the firewall for private networks. Notflix never opens ports on your router.`
              : "Only this computer can open Notflix (it listens on 127.0.0.1). Recommended until you need other devices."
          }
        />
        {leavingLan && <Notice tone="warn">You are connected from another device. After saving, this browser will lose access; continue on the server itself.</Notice>}
        <Toggle
          id="srv-proxy"
          label="Notflix is behind a reverse proxy"
          checked={form.reverseProxy}
          onChange={(v) => set({ reverseProxy: v })}
          description="Only if you already run a reverse proxy (Caddy, nginx, Traefik…) that adds HTTPS. Notflix then trusts its X-Forwarded-For/Proto headers. Leave off otherwise — trusting those headers without a proxy lets clients forge their address."
        />
        {form.reverseProxy && (
          <Field id="srv-public" label="Public address" error={errors.publicUrl} hint="The HTTPS address your proxy serves, e.g. https://notflix.example.com. Exposing Notflix to the internet is your decision and configuration; see docs/SECURITY.md first.">
            <input id="srv-public" className={fieldClass} value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://notflix.example.com" aria-invalid={Boolean(errors.publicUrl)} />
          </Field>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-[1fr_10rem]">
        <Field id="srv-cache" label="Media cache folder" error={errors.cacheDirectory} hint="Temporary video segments while converting. Disposable; never holds accounts or settings. A fast drive with free space is best.">
          <input id="srv-cache" className={fieldClass} value={form.cacheDirectory} onChange={(e) => set({ cacheDirectory: e.target.value })} spellCheck={false} aria-invalid={Boolean(errors.cacheDirectory)} />
        </Field>
        <Field id="srv-cache-max" label="Maximum size (GB)" error={errors.cacheMaxGiB} hint="Oldest data is removed first.">
          <input id="srv-cache-max" className={fieldClass} inputMode="numeric" value={form.cacheMaxGiB} onChange={(e) => set({ cacheMaxGiB: e.target.value.replace(/\D/g, "").slice(0, 4) })} aria-invalid={Boolean(errors.cacheMaxGiB)} />
        </Field>
      </div>

      <Field id="srv-data" label="Data folder" hint={<>Accounts, settings and credentials live here (access limited to the account running Notflix). To move it, stop Notflix and run <code className="rounded bg-white/10 px-1">scripts\notflix.ps1 move-data -To &lt;folder&gt;</code>.</>}>
        <input id="srv-data" className={fieldClass} value={view.storage.dataDir} readOnly disabled />
      </Field>

      {view.listening?.pending && <Notice tone="warn">Notflix could not switch to port {view.listening.pending.port}: {view.listening.pending.error}</Notice>}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <div className="flex justify-end">
        <Button type="submit" busy={busy}>
          {mode === "setup" ? "Save and continue" : "Save server settings"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Metadata (TMDB)

interface MetadataView {
  tmdb: { required: boolean; configured: boolean; hint: string; validatedAt: string | null };
  result?: { ok: boolean; status: string; message: string };
}

export function MetadataPanel({ mode, onSaved }: PanelProps) {
  const [view, setView] = useState<MetadataView | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  useEffect(() => {
    void api<MetadataView>("/api/config/metadata").then(({ ok, data }) => (ok ? setView(data) : setMessage({ tone: "error", text: data.error ?? "Could not load." })));
  }, []);

  if (!view) return message ? <Notice tone="error">{message.text}</Notice> : <Loading />;

  const run = async (action: "test" | "save" | "remove") => {
    setBusy(action);
    setMessage(null);
    const { ok, data } =
      action === "remove"
        ? await api<MetadataView>("/api/config/metadata", { method: "DELETE" })
        : await api<MetadataView>("/api/config/metadata", { method: action === "save" ? "PUT" : "POST", body: { tmdbApiKey: key.trim() } });
    setBusy(null);
    if (data.tmdb) setView(data);
    if (action === "remove") {
      setMessage(ok ? { tone: "warn", text: "TMDB key removed. Browsing needs it." } : { tone: "error", text: data.error ?? "Failed." });
      return;
    }
    const result = data.result;
    if (!ok || !result?.ok) {
      setMessage({ tone: "error", text: result?.message ?? data.error ?? "TMDB check failed." });
      return;
    }
    if (action === "save") {
      setKey("");
      setMessage({ tone: "ok", text: "TMDB connected." });
      onSaved?.();
    } else {
      setMessage({ tone: "ok", text: result.message });
    }
  };

  return (
    <div className="space-y-5">
      <Notice>
        Notflix uses <strong className="text-white">The Movie Database (TMDB)</strong> for the catalog, posters, details, episodes and age ratings. A free key is
        required. Create one at{" "}
        <a className="underline hover:text-white" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
          themoviedb.org/settings/api <ExternalLink className="inline h-3 w-3" />
        </a>{" "}
        and paste either the <em>API Key</em> or the <em>API Read Access Token</em>. No other metadata service is needed.
      </Notice>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-netflix-light-gray">Status:</span>
        {view.tmdb.configured ? (
          view.tmdb.validatedAt ? <Pill tone="ok">Connected</Pill> : <Pill tone="warn">Saved, not verified</Pill>
        ) : (
          <Pill tone="error">Not set</Pill>
        )}
        {view.tmdb.hint && <span className="text-netflix-gray">key {view.tmdb.hint}</span>}
      </div>
      <Field id="tmdb-key" label={view.tmdb.configured ? "Replace TMDB key" : "TMDB API key or read access token"} hint="Stored on this server only. It is never shown again or sent to browsers.">
        <input id="tmdb-key" type="password" className={fieldClass} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste key" />
      </Field>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        {mode === "settings" && view.tmdb.configured && (
          <Button variant="danger" busy={busy === "remove"} onClick={() => void run("remove")}>
            Remove
          </Button>
        )}
        <Button variant="secondary" busy={busy === "test"} disabled={!key.trim() && !view.tmdb.configured} onClick={() => void run("test")}>
          Test
        </Button>
        <Button busy={busy === "save"} disabled={!key.trim()} onClick={() => void run("save")}>
          {mode === "setup" ? "Save and continue" : "Save"}
        </Button>
        {mode === "setup" && view.tmdb.configured && view.tmdb.validatedAt && !key.trim() && (
          <Button variant="secondary" onClick={() => onSaved?.()}>
            Keep current key
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Debrid provider and release sources

interface DebridView {
  provider: { id: string; name: string; credentialLabel: string; credentialHelpUrl: string };
  configured: boolean;
  hint: string;
  validatedAt: string | null;
  account: string | null;
  sources: { torrentio: boolean; peerflix: boolean; custom: boolean };
  customSourceConfigured: boolean;
  sourceChoices: Array<{ id: "torrentio" | "peerflix" | "custom"; name: string; disclosure: string }>;
  status?: { status: string; message: string; username?: string; daysLeft?: number } | null;
}

export function DebridPanel({ mode, onSaved }: PanelProps) {
  const [view, setView] = useState<DebridView | null>(null);
  const [token, setToken] = useState("");
  const [sources, setSources] = useState<DebridView["sources"]>({ torrentio: true, peerflix: false, custom: false });
  const [customUrl, setCustomUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  useEffect(() => {
    void api<DebridView>("/api/config/debrid").then(({ ok, data }) => {
      if (!ok) return setMessage({ tone: "error", text: data.error ?? "Could not load." });
      setView(data);
      setSources(data.sources);
    });
  }, []);

  if (!view) return message ? <Notice tone="error">{message.text}</Notice> : <Loading />;
  const p = view.provider;
  const anySource = sources.torrentio || sources.peerflix || (sources.custom && (customUrl.trim() || view.customSourceConfigured));

  const describeStatus = (s: NonNullable<DebridView["status"]>) =>
    s.status === "active"
      ? { tone: "ok" as const, text: `Connected${s.username ? ` as ${s.username}` : ""}. ${s.message}` }
      : s.status === "not-premium"
        ? { tone: "warn" as const, text: `${s.message} Streaming needs an active premium subscription.` }
        : { tone: "error" as const, text: s.message };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    const { data } = await api<DebridView>("/api/config/debrid", { method: "POST", body: token.trim() ? { token: token.trim() } : {} });
    setBusy(null);
    if (data.provider) setView(data);
    setMessage(data.status ? describeStatus(data.status) : { tone: "error", text: data.error ?? "Check failed." });
  };

  const save = async () => {
    setBusy("save");
    setMessage(null);
    const body: Record<string, unknown> = { sources };
    if (token.trim()) body.token = token.trim();
    if (sources.custom) body.customUrl = customUrl.trim() || undefined;
    const { ok, data } = await api<DebridView>("/api/config/debrid", { method: "PUT", body });
    setBusy(null);
    if (data.provider) {
      setView(data);
      setSources(data.sources);
    }
    if (!ok) {
      setMessage({ tone: "error", text: data.error ?? "Could not save." });
      return;
    }
    setToken("");
    setCustomUrl("");
    if (data.status) setMessage(describeStatus(data.status));
    else setMessage({ tone: "ok", text: "Saved." });
    if (data.validatedAt && (data.sources.torrentio || data.sources.peerflix || data.sources.custom)) onSaved?.();
  };

  const remove = async () => {
    setBusy("remove");
    const { data } = await api<DebridView>("/api/config/debrid", { method: "DELETE" });
    setBusy(null);
    if (data.provider) setView(data);
    setMessage({ tone: "warn", text: `${p.name} disconnected. Playback needs it.` });
  };

  return (
    <div className="space-y-6">
      <Notice>
        Notflix plays titles through <strong className="text-white">your own {p.name} account</strong>. Paste the {p.credentialLabel} from{" "}
        <a className="underline hover:text-white" href={p.credentialHelpUrl} target="_blank" rel="noreferrer">
          {p.credentialHelpUrl.replace(/^https?:\/\//, "")} <ExternalLink className="inline h-3 w-3" />
        </a>
        . It stays on this server: browsers, phones and TVs never receive it.
      </Notice>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-netflix-light-gray">Account:</span>
        {view.configured ? (
          view.validatedAt ? <Pill tone="ok">Connected{view.account ? ` · ${view.account}` : ""}</Pill> : <Pill tone="warn">Saved, not verified</Pill>
        ) : (
          <Pill tone="error">Not connected</Pill>
        )}
        {view.hint && <span className="text-netflix-gray">token {view.hint}</span>}
      </div>

      <Field id="rd-token" label={view.configured ? `Replace ${p.credentialLabel}` : `${p.name} ${p.credentialLabel}`} hint="Checked with Real-Debrid before it is saved.">
        <input id="rd-token" type="password" className={fieldClass} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste token" />
      </Field>

      <fieldset className="space-y-3 rounded-md bg-white/[0.03] p-3 ring-1 ring-white/10">
        <legend className="px-1 text-sm font-medium text-white">Release search</legend>
        <p className="text-[13px] leading-relaxed text-netflix-gray">
          To find a title, Notflix asks a release index which files exist and which are already cached on {p.name}. Choose at least one. Notflix does not
          host or provide any media; you are responsible for what you access with your account.
        </p>
        {view.sourceChoices.map((c) => (
          <Toggle
            key={c.id}
            id={`src-${c.id}`}
            label={c.name}
            description={c.disclosure}
            checked={sources[c.id]}
            onChange={(v) => setSources((s) => ({ ...s, [c.id]: v }))}
          />
        ))}
        {sources.custom && (
          <Field id="src-custom" label="Custom addon URL" hint={view.customSourceConfigured ? "A custom URL is stored. Paste a new one to replace it." : "The addon's base URL (https://…), with or without /manifest.json."}>
            <input id="src-custom" type="password" className={fieldClass} value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="https://…" />
          </Field>
        )}
        {!anySource && <Notice tone="warn">With no release source enabled, nothing can be played.</Notice>}
      </fieldset>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        {mode === "settings" && view.configured && (
          <Button variant="danger" busy={busy === "remove"} onClick={() => void remove()}>
            Disconnect
          </Button>
        )}
        <Button variant="secondary" busy={busy === "test"} disabled={!token.trim() && !view.configured} onClick={() => void test()}>
          Test connection
        </Button>
        <Button busy={busy === "save"} disabled={(!token.trim() && !view.configured) || !anySource} onClick={() => void save()}>
          {mode === "setup" ? "Save and continue" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Hardware acceleration

interface Backend {
  id: string;
  label: string;
  vendor: string;
  kind: string;
  status: "verified" | "detected" | "unsupported";
  encoders: Record<string, string>;
  decoders: Record<string, string>;
  device: string | null;
  notes: string[];
}

interface HardwareView {
  engine: {
    online: boolean;
    reason?: string;
    error?: string;
    version?: string;
    capabilities?: {
      platform?: { os: string; arch: string; osDescription?: string };
      ffmpeg?: { available: boolean; version?: string; path?: string };
      ffprobe?: { available: boolean; version?: string; path?: string };
      adapters?: Array<{ id: string; name: string; vendor: string; driver?: string | null; virtual?: boolean; memoryMiB?: number | null }>;
      backends?: Backend[];
      selection?: { requested: string; effective: string; device: string | null; fallbackReason: string | null };
      software?: { encoders: string[] };
      detectionSeconds?: number;
    };
  };
  settings: { hardwareAcceleration: string; hardwareDevice: string | null; maxConcurrentTranscodes: number };
  engineUpdated?: boolean;
}

const CODEC_LABEL: Record<string, string> = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", mpeg2video: "MPEG-2", mpeg4: "MPEG-4" };

function codecState(state: string) {
  if (state === "verified") return <span className="text-emerald-300">✓</span>;
  if (state === "failed") return <span className="text-red-300">✗</span>;
  if (state === "untested") return <span className="text-amber-300">?</span>;
  return <span className="text-white/25">–</span>;
}

export function HardwarePanel({ mode, onSaved }: PanelProps) {
  const [view, setView] = useState<HardwareView | null>(null);
  const [choice, setChoice] = useState("auto");
  const [device, setDevice] = useState("");
  const [maxJobs, setMaxJobs] = useState("3");
  const [busy, setBusy] = useState<"detect" | "save" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  const load = useCallback(async (refresh = false) => {
    setBusy(refresh ? "detect" : null);
    const { ok, data } = await api<HardwareView>(`/api/config/hardware${refresh ? "?refresh=1" : ""}`);
    setBusy(null);
    if (!ok) {
      setMessage({ tone: "error", text: data.error ?? "Could not load." });
      return;
    }
    setView(data);
    setChoice(data.settings.hardwareAcceleration);
    setDevice(data.settings.hardwareDevice ?? "");
    setMaxJobs(String(data.settings.maxConcurrentTranscodes));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
    void load();
  }, [load]);

  if (!view) return message ? <Notice tone="error">{message.text}</Notice> : <Loading />;
  const caps = view.engine.capabilities;
  const backends = caps?.backends ?? [];
  const verified = backends.filter((b) => b.status === "verified" && b.kind !== "decode");
  const adapters = (caps?.adapters ?? []).filter((a) => !a.virtual);
  const selection = caps?.selection;
  // The engine selects a device by index among the chosen backend's own adapters.
  const vendorFor: Record<string, string> = { nvenc: "nvidia", amf: "amd", qsv: "intel" };
  const deviceChoices = adapters.filter((a) => a.vendor === vendorFor[choice]);

  const save = async () => {
    setBusy("save");
    setMessage(null);
    const { ok, data } = await api<HardwareView>("/api/config/hardware", {
      method: "PUT",
      body: { hardwareAcceleration: choice, hardwareDevice: device || null, maxConcurrentTranscodes: Number(maxJobs) },
    });
    setBusy(null);
    if (!ok) {
      setMessage({ tone: "error", text: data.error ?? "Could not save." });
      return;
    }
    setView(data);
    const sel = data.engine.capabilities?.selection;
    setMessage(
      sel?.fallbackReason
        ? { tone: "warn", text: `Saved. ${sel.fallbackReason}` }
        : { tone: "ok", text: data.engineUpdated === false ? "Saved. It applies when the media engine starts." : "Saved and applied." }
    );
    onSaved?.();
  };

  if (!view.engine.online) {
    return (
      <div className="space-y-4">
        <Notice tone="error">
          The media engine is not running, so hardware can&apos;t be checked. Start Notflix with the launcher (it starts the engine too), then try again.
          {view.engine.reason ? ` (${view.engine.reason})` : ""}
        </Notice>
        <div className="flex justify-end">
          <Button variant="secondary" busy={busy === "detect"} onClick={() => void load(true)}>
            <RefreshCw className="h-4 w-4" /> Check again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Notice>
        Notflix plays files as they are whenever your browser can (<strong className="text-white">Direct Play</strong>), repackages them without re-encoding when
        only the container is the problem, converts just the audio when needed, and converts video only as a last resort. A graphics card is optional: every
        option below is tested on this computer with short sample encodes, and the processor (software) is always available as a fallback.
      </Notice>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md bg-white/[0.03] p-3 ring-1 ring-white/10">
          <p className="text-netflix-gray">System</p>
          <p className="text-white">{caps?.platform ? `${caps.platform.osDescription ?? caps.platform.os} · ${caps.platform.arch}` : "Unknown"}</p>
        </div>
        <div className="rounded-md bg-white/[0.03] p-3 ring-1 ring-white/10">
          <p className="text-netflix-gray">FFmpeg / FFprobe</p>
          <p className="text-white">
            {caps?.ffmpeg?.available ? `FFmpeg ${caps.ffmpeg.version ?? ""}` : <span className="text-red-300">FFmpeg not found</span>}
            {" · "}
            {caps?.ffprobe?.available === false ? <span className="text-red-300">FFprobe not found</span> : "FFprobe ok"}
          </p>
        </div>
      </div>
      {caps?.ffmpeg && !caps.ffmpeg.available && (
        <Notice tone="error">
          FFmpeg is required for everything except Direct Play. Install it (on Windows: <code>winget install Gyan.FFmpeg</code>), restart Notflix, then check
          again. See docs/INSTALL-WINDOWS.md.
        </Notice>
      )}

      <div>
        <p className="mb-2 text-sm font-medium text-white">Graphics adapters found</p>
        {adapters.length === 0 ? (
          <p className="text-sm text-netflix-gray">No physical graphics adapter detected. Video conversion will use the processor.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {adapters.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="text-white">{a.name}</span>
                <Pill tone="muted">{a.vendor}</Pill>
                {a.driver && <span className="text-netflix-gray">driver {a.driver}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm" data-testid="hw-backends">
          <thead className="text-netflix-gray">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Acceleration</th>
              <th className="py-1.5 pr-3 font-medium">Result on this computer</th>
              <th className="py-1.5 pr-3 font-medium">Encode</th>
              <th className="py-1.5 font-medium">Decode</th>
            </tr>
          </thead>
          <tbody>
            {backends.map((b) => (
              <tr key={b.id} className="border-t border-white/10 align-top">
                <td className="py-2 pr-3 text-white">
                  {b.label}
                  {b.notes.length > 0 && <p className="mt-0.5 max-w-xs break-words text-[12px] text-netflix-gray">{b.notes[0]}</p>}
                </td>
                <td className="py-2 pr-3">
                  {b.status === "verified" ? <Pill tone="ok">Working</Pill> : b.status === "detected" ? <Pill tone="warn">Test failed</Pill> : <Pill tone="muted">Not available</Pill>}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {Object.entries(b.encoders).map(([c, s]) => (
                    <span key={c} className="mr-2">
                      {CODEC_LABEL[c] ?? c} {codecState(s)}
                    </span>
                  ))}
                </td>
                <td className="py-2 text-[13px]">
                  <div className="flex flex-wrap gap-x-2">
                    {Object.entries(b.decoders)
                      .filter(([, s]) => s !== "not-listed")
                      .map(([c, s]) => (
                        <span key={c} className="whitespace-nowrap">
                          {CODEC_LABEL[c] ?? c} {codecState(s)}
                        </span>
                      ))}
                  </div>
                </td>
              </tr>
            ))}
            <tr className="border-t border-white/10">
              <td className="py-2 pr-3 text-white">Software (processor)</td>
              <td className="py-2 pr-3">
                <Pill tone={caps?.software?.encoders?.includes("libx264") ? "ok" : "error"}>{caps?.software?.encoders?.includes("libx264") ? "Always available" : "x264 missing"}</Pill>
              </td>
              <td className="py-2 pr-3">H.264 {codecState(caps?.software?.encoders?.includes("libx264") ? "verified" : "failed")}</td>
              <td className="py-2 text-[13px] text-netflix-gray">all formats FFmpeg supports</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-[12px] text-netflix-gray">Tested on this computer: ✓ working · ✗ tested and failed · ? listed, not testable here · – not offered{caps?.detectionSeconds ? ` · checked in ${caps.detectionSeconds}s` : ""}</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-[1fr_1fr_9rem]">
        <Field id="hw-choice" label="Video conversion uses" hint={selection ? `Now: ${selection.effective === "software" ? "the processor" : (backends.find((b) => b.id === selection.effective)?.label ?? selection.effective)}` : undefined}>
          <select id="hw-choice" className={fieldClass} value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="auto">Automatic (best tested option)</option>
            {verified.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
            <option value="off">Processor only (no GPU)</option>
          </select>
        </Field>
        <Field id="hw-device" label="Graphics adapter" hint="Only when you have several GPUs of the chosen kind.">
          <select id="hw-device" className={fieldClass} value={device} onChange={(e) => setDevice(e.target.value)} disabled={deviceChoices.length < 2}>
            <option value="">Automatic</option>
            {deviceChoices.map((a, i) => (
              <option key={a.id} value={String(i)}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="hw-max" label="Simultaneous conversions">
          <input id="hw-max" className={fieldClass} inputMode="numeric" value={maxJobs} onChange={(e) => setMaxJobs(e.target.value.replace(/\D/g, "").slice(0, 1))} />
        </Field>
      </div>
      {selection?.fallbackReason && <Notice tone="warn">{selection.fallbackReason}</Notice>}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" busy={busy === "detect"} onClick={() => void load(true)}>
          <RefreshCw className="h-4 w-4" /> Test again
        </Button>
        <Button busy={busy === "save"} onClick={() => void save()}>
          {mode === "setup" ? "Save and continue" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Summary

export interface Requirement {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

export interface InstallSummary {
  setup: { completed: boolean };
  server: {
    allowLan: boolean;
    reverseProxy: boolean;
    bindAddress: string;
    urls: { local: string; lan: string[]; hostname: string | null; public: string | null };
  };
  storage: { dataDir: string; cacheDirectory: string; cacheMaxGiB: number };
  credentials?: { protection: string; state: string; label: string };
  owner: { name: string; displayName: string | null } | null;
  metadata: { tmdb: { configured: boolean; validatedAt: string | null } };
  debrid: { provider: string; configured: boolean; validatedAt: string | null; account: string | null; sources: Record<string, boolean> };
  hardware: { engineOnline: boolean; selection: { effective: string; effectiveLabel?: string; fallbackReason: string | null } | null; verified: string[]; detected: string[]; ffmpeg: { available: boolean; version?: string } | null };
  requirements: Requirement[];
}

export function SummaryList({ summary }: { summary: InstallSummary }) {
  const rows: Array<[string, string]> = [
    ["Server address", [summary.server.urls.local, ...summary.server.urls.lan, summary.server.urls.hostname, summary.server.urls.public].filter(Boolean).join("  ·  ")],
    ["Network", summary.server.allowLan ? "This computer and your local network" : "This computer only"],
    ["Administrator", summary.owner ? `${summary.owner.displayName ?? summary.owner.name} (${summary.owner.name})` : "Not created"],
    ["Metadata", summary.metadata.tmdb.validatedAt ? "TMDB connected" : summary.metadata.tmdb.configured ? "TMDB saved, not verified" : "TMDB not set"],
    [summary.debrid.provider, summary.debrid.validatedAt ? `Connected${summary.debrid.account ? ` as ${summary.debrid.account}` : ""}` : summary.debrid.configured ? "Saved, not verified" : "Not connected"],
    ["Release search", Object.entries(summary.debrid.sources).filter(([, v]) => v).map(([k]) => k[0].toUpperCase() + k.slice(1)).join(", ") || "None"],
    [
      "Hardware acceleration",
      summary.hardware.engineOnline
        ? summary.hardware.verified.length
          ? `${summary.hardware.verified.join(", ")} (tested)${summary.hardware.selection ? ` — converting with ${summary.hardware.selection.effectiveLabel ?? summary.hardware.selection.effective}` : ""}`
          : "None available — the processor converts video when needed"
        : "Unknown (media engine not running)",
    ],
    ["Media cache", `${summary.storage.cacheDirectory} (up to ${summary.storage.cacheMaxGiB} GB)`],
    ["Data folder", summary.storage.dataDir],
    ...(summary.credentials ? [["Stored credentials", summary.credentials.label] as [string, string]] : []),
  ];
  return (
    <dl className="divide-y divide-white/10 text-sm" data-testid="setup-summary">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[11rem_1fr]">
          <dt className="text-netflix-gray">{k}</dt>
          <dd className="break-words text-white">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
