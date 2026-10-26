import "server-only";
import os from "os";
import { engineHealth, engineJson, engineUrl } from "../media-engine/client";
import { readJson } from "./store.mjs";
import { bindAddressFor } from "./config.mjs";
import { dataDir, paths, secrets, serverConfig } from "./runtime";
import { hasOwner, listUsers } from "../users";
import { debridProvider, enabledSourceAddons } from "../debrid";
import { secretHint, secretsStatus } from "./secrets.mjs";

/** Subset of the engine's /capabilities response the web app relies on. */
export interface EngineCapabilities {
  platform?: { os: string; arch: string; osDescription?: string };
  ffmpeg?: { available: boolean; version?: string; path?: string };
  ffprobe?: { available: boolean; version?: string; path?: string };
  adapters?: Array<{ id: string; name: string; vendor: string; driver?: string | null; virtual?: boolean; memoryMiB?: number | null }>;
  backends?: Array<{
    id: string;
    label: string;
    vendor: string;
    kind: string;
    status: "verified" | "detected" | "unsupported";
    encoders: Record<string, string>;
    decoders: Record<string, string>;
    device: string | null;
    notes: string[];
  }>;
  selection?: { requested: string; effective: string; device: string | null; fallbackReason: string | null };
  software?: { encoders: string[] };
  detectedAt?: string;
  detectionSeconds?: number;
  [key: string]: unknown;
}

export interface EngineStatus {
  online: boolean;
  url: string;
  reason?: string;
  version?: string;
  capabilities?: EngineCapabilities;
  error?: string;
}

export async function engineStatus(refresh = false): Promise<EngineStatus> {
  const url = engineUrl();
  const health = await engineHealth();
  if (!health.online) return { online: false, url, reason: health.reason };
  try {
    const capabilities = await engineJson<EngineCapabilities>(`/capabilities${refresh ? "?refresh=true" : ""}`, { timeoutMs: 120_000 });
    return { online: true, url, version: health.version, capabilities };
  } catch (err) {
    return { online: true, url, version: health.version, error: err instanceof Error ? err.message : "capabilities failed" };
  }
}

/** What the custom server (server.mjs) reports about the address it is actually listening on. */
export interface ListenStatus {
  host: string;
  port: number;
  pid: number;
  since: string;
  pending?: { host: string; port: number; error: string } | null;
}

export function listenStatus(): ListenStatus | null {
  const s = readJson(paths().listenStatusFile, null as ListenStatus | null);
  return s && typeof s.port === "number" ? s : null;
}

/** LAN advertisement (mDNS/DNS-SD) as reported by server.mjs; see lan-advertise.mjs. */
export interface AdvertiseStatus {
  active: boolean;
  serviceType: string;
  name: string | null;
  port: number | null;
  host: string | null;
  addresses: string[];
  reason: string | null;
  error: string | null;
  since: string;
  pid: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** null when the web server isn't running here (or left a stale file behind after a crash). */
export function advertiseStatus(): AdvertiseStatus | null {
  const s = readJson(paths().advertiseStatusFile, null as AdvertiseStatus | null);
  return s && typeof s.pid === "number" && alive(s.pid) ? s : null;
}

/** Addresses other devices could use (non-internal IPv4), for display only. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254.")) out.push(n.address);
    }
  }
  return out;
}

export interface Requirement {
  id: "owner" | "metadata" | "debrid" | "sources" | "engine" | "ffmpeg";
  ok: boolean;
  label: string;
  detail: string;
}

/** Everything first-run setup must have before it can be marked complete. */
export function requirements(engine: EngineStatus): Requirement[] {
  const cfg = serverConfig();
  const sec = secrets();
  const caps = engine.capabilities;
  const ffmpegOk = Boolean(caps?.ffmpeg?.available);
  const ffprobeOk = caps?.ffprobe ? Boolean(caps.ffprobe.available) : ffmpegOk;
  const provider = debridProvider();
  return [
    { id: "owner", ok: hasOwner(), label: "Owner account", detail: hasOwner() ? "Created" : "Create the owner account" },
    {
      id: "metadata",
      ok: Boolean(sec.tmdbApiKey && cfg.metadata.tmdbValidatedAt),
      label: "TMDB metadata",
      detail: sec.tmdbApiKey ? (cfg.metadata.tmdbValidatedAt ? "Connected" : "Not verified yet") : "Add a TMDB API key",
    },
    {
      id: "debrid",
      ok: Boolean(sec.realDebridToken && cfg.debrid.validatedAt),
      label: provider.displayName,
      detail: sec.realDebridToken ? (cfg.debrid.validatedAt ? "Connected" : "Not verified yet") : `Add your ${provider.displayName} ${provider.credentialLabel}`,
    },
    {
      id: "sources",
      ok: enabledSourceAddons().length > 0,
      label: "Release search",
      detail:
        enabledSourceAddons().length > 0
          ? enabledSourceAddons().map((a) => a.name).join(", ")
          : sec.realDebridToken
            ? "Enable at least one release source"
            : `Works once ${provider.displayName} is connected`,
    },
    {
      id: "engine",
      ok: engine.online,
      label: "Media engine",
      detail: engine.online ? `Running (${engine.version ?? "unknown version"})` : "Not running — start Notflix with the launcher",
    },
    {
      id: "ffmpeg",
      ok: engine.online && ffmpegOk && ffprobeOk,
      label: "FFmpeg and FFprobe",
      detail: !engine.online
        ? "Unknown until the media engine runs"
        : ffmpegOk && ffprobeOk
          ? `FFmpeg ${caps?.ffmpeg?.version ?? ""}`.trim()
          : "Not found — install FFmpeg (see docs/INSTALL-WINDOWS.md)",
    },
  ];
}

/** Non-secret overview for the setup summary and Settings → System. */
export async function installSummary(opts: { refreshEngine?: boolean } = {}) {
  const cfg = serverConfig();
  const sec = secrets();
  const engine = await engineStatus(opts.refreshEngine);
  const listen = listenStatus();
  const owner = listUsers().find((u) => u.role === "owner");
  const port = listen?.port ?? cfg.server.port;
  const local = `http://localhost:${port}`;
  const lan = cfg.server.allowLan ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [];
  const caps = engine.capabilities;
  return {
    setup: cfg.setup,
    server: {
      ...cfg.server,
      bindAddress: bindAddressFor(cfg),
      listening: listen,
      urls: { local, lan, hostname: cfg.server.hostname ? `http://${cfg.server.hostname}:${port}` : null, public: cfg.server.publicUrl || null },
    },
    storage: { dataDir: dataDir(), ...cfg.storage },
    credentials: (({ protection, state, label }) => ({ protection, state, label }))(secretsStatus(dataDir())),
    owner: owner ? { name: owner.name, displayName: owner.displayName ?? null } : null,
    metadata: { tmdb: { configured: Boolean(sec.tmdbApiKey), hint: secretHint(sec.tmdbApiKey), validatedAt: cfg.metadata.tmdbValidatedAt } },
    debrid: {
      provider: debridProvider().displayName,
      configured: Boolean(sec.realDebridToken),
      hint: secretHint(sec.realDebridToken),
      validatedAt: cfg.debrid.validatedAt,
      account: cfg.debrid.account,
      sources: cfg.debrid.sources,
    },
    hardware: {
      engineOnline: engine.online,
      selection: caps?.selection
        ? {
            ...caps.selection,
            effectiveLabel:
              caps.selection.effective === "software"
                ? "the processor (software)"
                : (caps.backends ?? []).find((b) => b.id === caps.selection!.effective)?.label ?? caps.selection.effective,
          }
        : null,
      verified: (caps?.backends ?? []).filter((b) => b.status === "verified").map((b) => b.label),
      detected: (caps?.backends ?? []).filter((b) => b.status === "detected").map((b) => b.label),
      ffmpeg: caps?.ffmpeg ?? null,
    },
    requirements: requirements(engine),
  };
}
