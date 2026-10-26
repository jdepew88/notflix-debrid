import dns from "dns/promises";
import net from "net";
import { episodeMatchesPath, parseEpisodeFromText } from "./episode-parse";

const DEBRID_BASE = "https://api.real-debrid.com/rest/1.0";

/** auth: token invalid/expired · premium: account not premium · unavailable: file/torrent gone ·
 *  rate-limited: RD throttled us · network: RD unreachable · other */
export type DebridErrorKind = "auth" | "premium" | "unavailable" | "rate-limited" | "network" | "other";

export class DebridError extends Error {
  constructor(
    message: string,
    public status?: number,
    public kind: DebridErrorKind = "other"
  ) {
    super(message);
    this.name = "DebridError";
  }
}

function classifyDebrid(status: number, body: string): DebridErrorKind {
  const text = body.toLowerCase();
  if (status === 401 || text.includes("bad_token") || text.includes("bad token")) return "auth";
  if (status === 403 && (text.includes("permission") || text.includes("premium") || text.includes("locked"))) return "premium";
  if (status === 429 || text.includes("too_many_requests")) return "rate-limited";
  if (status === 404 || status === 451 || text.includes("unavailable_file") || text.includes("hoster_unavailable")) return "unavailable";
  if (status === 503 || status === 502) return "network";
  return "other";
}

const FRIENDLY: Record<DebridErrorKind, string> = {
  auth: "Real-Debrid rejected the API token. Update it in Settings.",
  premium: "Your Real-Debrid account is not premium (or is locked).",
  unavailable: "That file is no longer available on Real-Debrid.",
  "rate-limited": "Real-Debrid is rate limiting requests. Try again in a moment.",
  network: "Real-Debrid could not be reached.",
  other: "Real-Debrid returned an error.",
};

async function debridFetch<T>(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  // Bounded retries for throttling and transient server errors; never for auth/availability errors.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${DEBRID_BASE}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
        signal: options.signal ?? AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw new DebridError(FRIENDLY.network, undefined, "network");
    }

    if (res.ok) {
      if (res.status === 204) return {} as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    const text = await res.text().catch(() => "");
    const kind = classifyDebrid(res.status, text);
    if ((kind === "rate-limited" || res.status >= 500) && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 800 * (attempt + 1)));
      continue;
    }
    throw new DebridError(FRIENDLY[kind], res.status, kind);
  }
}

export interface DebridUser {
  id: number;
  username: string;
  email: string;
  premium: number;
  expiration: string;
}

export interface DebridTorrent {
  id: string;
  filename: string;
  hash: string;
  bytes: number;
  host: string;
  split: number;
  progress: number;
  status: string;
  added: string;
  links: string[];
  files: Array<{
    id: number;
    path: string;
    bytes: number;
    selected: number;
  }>;
}

export async function getDebridUser(token: string): Promise<DebridUser> {
  return debridFetch<DebridUser>("/user", token);
}

export interface DebridAccountStatus {
  configured: boolean;
  status: "active" | "not-premium" | "invalid-token" | "unreachable" | "not-configured" | "error";
  username?: string;
  premium?: boolean;
  expiration?: string;
  daysLeft?: number;
  message: string;
}

/** Validates the token and reports whether the account can stream. Never returns the token. */
export async function checkDebridAccount(token: string): Promise<DebridAccountStatus> {
  if (!token) return { configured: false, status: "not-configured", message: "No Real-Debrid token configured." };
  try {
    const user = await getDebridUser(token);
    const premium = user.premium > 0;
    const exp = user.expiration ? new Date(user.expiration) : undefined;
    const daysLeft = exp ? Math.max(0, Math.floor((exp.getTime() - Date.now()) / 86_400_000)) : undefined;
    return {
      configured: true,
      status: premium ? "active" : "not-premium",
      username: user.username,
      premium,
      expiration: user.expiration,
      daysLeft,
      message: premium ? `Premium active${daysLeft != null ? ` · ${daysLeft} days left` : ""}` : "Account is not premium; streaming links are unavailable.",
    };
  } catch (err) {
    const e = err instanceof DebridError ? err : new DebridError(FRIENDLY.other);
    return {
      configured: true,
      status: e.kind === "auth" ? "invalid-token" : e.kind === "network" ? "unreachable" : e.kind === "premium" ? "not-premium" : "error",
      message: e.message,
    };
  }
}

export async function addMagnet(token: string, magnet: string): Promise<{ id: string }> {
  const body = new URLSearchParams({ magnet });
  return debridFetch<{ id: string }>("/torrents/addMagnet", token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

export async function getTorrentInfo(token: string, id: string): Promise<DebridTorrent> {
  return debridFetch<DebridTorrent>(`/torrents/info/${id}`, token);
}

export async function selectTorrentFiles(
  token: string,
  id: string,
  fileIds: string
): Promise<void> {
  const body = new URLSearchParams({ files: fileIds });
  await debridFetch<void>(`/torrents/selectFiles/${id}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

export async function unrestrictLink(token: string, link: string): Promise<{ download: string; filename: string; streamable: number }> {
  const body = new URLSearchParams({ link });
  return debridFetch<{ download: string; filename: string; streamable: number }>(
    "/unrestrict/link",
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );
}

const torrentListCache = new Map<string, { at: number; list: Promise<DebridTorrent[]> }>();

/** Account torrent list (cached 30 s; magnet lookups would otherwise refetch it every play). */
export async function listTorrents(token: string, fresh = false): Promise<DebridTorrent[]> {
  const key = token.slice(-12);
  const hit = torrentListCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = debridFetch<DebridTorrent[]>("/torrents?limit=500", token);
  torrentListCache.set(key, { at: Date.now(), list });
  list.catch(() => torrentListCache.delete(key));
  return list;
}

export async function deleteTorrent(token: string, id: string): Promise<void> {
  await debridFetch<void>(`/torrents/delete/${id}`, token, {
    method: "DELETE",
  });
}

const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi", ".xvid", ".mov", ".wmv", ".m4v", ".webm"];

export function isVideoFile(path: string): boolean {
  const lower = path.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function pickVideoFileForEpisode(
  torrent: DebridTorrent,
  season?: number,
  episode?: number
): number | null {
  const videos = torrent.files.filter((f) => isVideoFile(f.path));
  if (videos.length === 0) return null;

  if (season != null && episode != null) {
    const match = videos.find((f) => episodeMatchesPath(f.path, season, episode));
    if (match) return match.id;

    const sorted = [...videos].sort((a, b) => {
      const pa = parseEpisodeFromText(a.path);
      const pb = parseEpisodeFromText(b.path);
      if (!pa || !pb) return 0;
      if (pa.season !== pb.season) return pa.season - pb.season;
      return pa.episode - pb.episode;
    });
    const index = sorted.findIndex((f) => {
      const p = parseEpisodeFromText(f.path);
      return p?.season === season && p?.episode === episode;
    });
    if (index >= 0) return sorted[index].id;
  }

  const selected = videos.find((f) => f.selected === 1);
  if (selected) return selected.id;
  return videos[0].id;
}

export function pickBestVideoFile(torrent: DebridTorrent): number | null {
  return pickVideoFileForEpisode(torrent);
}

function isTorrentReady(torrent: DebridTorrent): boolean {
  return torrent.status === "downloaded" || torrent.progress >= 100;
}

async function waitForTorrentReady(
  token: string,
  torrentId: string,
  timeoutMs = 45_000
): Promise<DebridTorrent> {
  const start = Date.now();
  let delayMs = 250;

  while (Date.now() - start < timeoutMs) {
    const torrent = await getTorrentInfo(token, torrentId);
    if (isTorrentReady(torrent)) return torrent;
    if (torrent.status === "error" || torrent.status === "magnet_error") {
      throw new DebridError(`Torrent failed: ${torrent.status}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 3000);
  }
  throw new DebridError("Torrent download timed out on Real-Debrid");
}

/** Reuse an already-cached torrent on the RD account when the info-hash matches. */
export async function findOrAddTorrentByMagnet(
  token: string,
  magnet: string
): Promise<string> {
  const hash = extractInfoHash(magnet);
  if (hash) {
    const existing = await listTorrents(token);
    const match = existing.find((t) => t.hash.toLowerCase() === hash);
    if (match) return match.id;
  }
  const { id } = await addMagnet(token, magnet);
  return id;
}

export function extractMagnetFromText(text: string): string | null {
  const match = text.match(/magnet:\?[^"'\\s]+/i);
  return match ? decodeURIComponent(match[0]) : null;
}

export function extractInfoHash(text: string): string | null {
  const magnet = extractMagnetFromText(text) ?? text;
  const match = magnet.match(/btih:([a-f0-9]{40}|[a-z2-7]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

const DEBRID_DOWNLOAD_HOSTS = [
  "100.download.real-debrid.com",
  "20.download.real-debrid.com",
  "25.download.real-debrid.com",
  "30.download.real-debrid.com",
  "40.download.real-debrid.com",
];

/** Best download host per original host (lowest TCP connect time), re-measured every 30 minutes. */
const HOST_CHOICE_TTL_MS = 30 * 60 * 1000;
const hostChoice = new Map<string, { host: string; at: number; ms: number }>();
const unreachableUntil = new Map<string, number>();

function connectMs(address: string, family: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: address, port: 443, family });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok ? Date.now() - started : null);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Fastest successful TCP connect to any address of `host` (IPv6 and IPv4 tried in parallel). */
async function hostLatency(host: string, timeoutMs = 1500): Promise<number | null> {
  let addresses: { address: string; family: number }[] = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return null;
  }
  const times = await Promise.all(addresses.map((a) => connectMs(a.address, a.family, timeoutMs)));
  const ok = times.filter((t): t is number => t !== null);
  return ok.length ? Math.min(...ok) : null;
}

/**
 * Candidate servers for a Real-Debrid link. Links point at e.g. "lax5-4": the "-4" names are the
 * IPv4-only aliases, which some networks cannot reach, while the same server answers on its
 * dual-stack name ("lax5"). Same-region siblings come next and distant generic hosts last.
 */
export function debridHostCandidates(originalHost: string): string[] {
  const host = originalHost.toLowerCase();
  const out = [host];
  const m = /^([a-z]+)(\d+)(-4)?\.download\.real-debrid\.com$/.exec(host);
  if (m) {
    const [, region, num, v4] = m;
    if (v4) out.push(`${region}${num}.download.real-debrid.com`);
    for (let i = 1; i <= 6; i++) out.push(`${region}${i}.download.real-debrid.com`);
  }
  out.push(...DEBRID_DOWNLOAD_HOSTS);
  return out.filter((h, i, all) => all.indexOf(h) === i);
}

export function markDebridHostUnreachable(host: string): void {
  const normalized = host.toLowerCase();
  unreachableUntil.set(normalized, Date.now() + 10 * 60 * 1000);
  for (const [original, choice] of hostChoice) if (choice.host === normalized) hostChoice.delete(original);
}

/**
 * Rewrites a Real-Debrid download link to the server this PC reaches fastest. Every request the
 * media engine makes pays this latency (probing, seeking, segment reads), so a nearby server
 * shortens startup noticeably.
 */
export async function withReachableDebridHost(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.hostname.endsWith(".download.real-debrid.com")) return url;
  const originalHost = parsed.hostname.toLowerCase();

  const cached = hostChoice.get(originalHost);
  if (cached && Date.now() - cached.at < HOST_CHOICE_TTL_MS) {
    parsed.hostname = cached.host;
    return parsed.toString();
  }

  const now = Date.now();
  const candidates = debridHostCandidates(originalHost).filter((h) => (unreachableUntil.get(h) ?? 0) < now);
  const measured = await Promise.all(candidates.map(async (host) => ({ host, ms: await hostLatency(host) })));
  const reachable = measured.filter((m): m is { host: string; ms: number } => m.ms !== null);
  for (const m of measured) if (m.ms === null) unreachableUntil.set(m.host, now + 10 * 60 * 1000);
  if (reachable.length === 0) return url;

  // Prefer the original server unless another is clearly faster (>15 ms).
  reachable.sort((a, b) => a.ms - b.ms);
  const original = reachable.find((r) => r.host === originalHost);
  const best = original && original.ms <= reachable[0].ms + 15 ? original : reachable[0];
  hostChoice.set(originalHost, { host: best.host, at: now, ms: best.ms });
  if (best.host !== originalHost) {
    console.log(`[debrid] ${originalHost} → ${best.host} (${best.ms} ms connect)`);
  }
  parsed.hostname = best.host;
  return parsed.toString();
}

async function unrestrictTorrentLink(
  token: string,
  torrent: DebridTorrent,
  fileId: number
): Promise<{ streamUrl: string; filename: string }> {
  const selected = torrent.files.filter((f) => f.selected === 1);
  const linkIndex = selected.findIndex((f) => f.id === fileId);
  const link = torrent.links[linkIndex >= 0 ? linkIndex : 0] ?? torrent.links[0];
  if (!link) throw new DebridError("No download link for selected file");
  const unrestricted = await unrestrictLink(token, link);
  return {
    streamUrl: await withReachableDebridHost(unrestricted.download),
    filename: unrestricted.filename,
  };
}

export async function resolveTorrentStreamForEpisode(
  token: string,
  torrentId: string,
  season?: number,
  episode?: number
): Promise<{ streamUrl: string; filename: string }> {
  let torrent = await getTorrentInfo(token, torrentId);

  if (torrent.status === "waiting_files_selection") {
    const videoId = pickVideoFileForEpisode(torrent, season, episode);
    if (!videoId) throw new DebridError("No video files found in torrent");
    await selectTorrentFiles(token, torrentId, String(videoId));
    torrent = await getTorrentInfo(token, torrentId);
  }

  if (!isTorrentReady(torrent)) {
    torrent = await waitForTorrentReady(token, torrentId);
  }

  const videoId = pickVideoFileForEpisode(torrent, season, episode);
  if (!videoId) throw new DebridError("No matching episode file in torrent");

  const selected = torrent.files.filter((f) => f.selected === 1);
  const needsSelect =
    selected.length !== 1 || !selected.some((f) => f.id === videoId);

  if (needsSelect) {
    await selectTorrentFiles(token, torrentId, String(videoId));
    torrent = await getTorrentInfo(token, torrentId);
    if (!isTorrentReady(torrent)) {
      torrent = await waitForTorrentReady(token, torrentId);
    }
  }

  return unrestrictTorrentLink(token, torrent, videoId);
}

export async function resolveMagnetStreamForEpisode(
  token: string,
  magnet: string,
  season?: number,
  episode?: number
): Promise<{ streamUrl: string; filename: string }> {
  const id = await findOrAddTorrentByMagnet(token, magnet);
  return resolveTorrentStreamForEpisode(token, id, season, episode);
}

export async function resolveTorrentStream(
  token: string,
  torrentId: string,
  season?: number,
  episode?: number
): Promise<{ streamUrl: string; filename: string }> {
  return resolveTorrentStreamForEpisode(token, torrentId, season, episode);
}
