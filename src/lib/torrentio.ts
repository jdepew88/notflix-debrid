import {
  fetchStremioStreams,
  isLikelyEnglishStream,
  listPlayableStremioStreams,
  normalizeStremioBaseUrl,
  streamScore,
  type StremioStream,
  type StremioStreamOption,
} from "./stremio-streams";

export type TorrentioStream = StremioStream;
export type TorrentioStreamOption = StremioStreamOption;

export {
  isLikelyEnglishStream,
  listPlayableStremioStreams as listPlayableTorrentioStreams,
  normalizeStremioBaseUrl as normalizeTorrentioBaseUrl,
  streamScore,
};

export function buildDefaultTorrentioUrl(realDebridToken: string): string {
  return `https://torrentio.strem.fun/realdebrid=${encodeURIComponent(realDebridToken)}|sort=quality|language=english`;
}

export function buildStreamVideoId(options: {
  tmdbId?: number;
  imdbId?: string;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}): string {
  const { tmdbId, imdbId, type, season, episode } = options;

  if (imdbId) {
    const id = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
    if (type === "series" && season != null && episode != null) {
      return `${id}:${season}:${episode}`;
    }
    return id;
  }

  if (!tmdbId) {
    throw new Error("tmdbId or imdbId required for torrent search");
  }

  if (type === "series" && season != null && episode != null) {
    return `tmdb:${tmdbId}:${season}:${episode}`;
  }

  return `tmdb:${tmdbId}`;
}

export async function fetchTorrentioStreams(
  baseUrl: string,
  type: "movie" | "series",
  videoId: string
): Promise<TorrentioStream[]> {
  return fetchStremioStreams(baseUrl, type, videoId);
}

export function pickBestTorrentioStream(streams: TorrentioStream[]): TorrentioStream | null {
  const candidates = streams
    .filter((s) => s.url?.startsWith("http"))
    .filter(isLikelyEnglishStream)
    .sort((a, b) => streamScore(b) - streamScore(a));

  return candidates[0] ?? null;
}

export interface ResolveTorrentioOptions {
  season?: number;
  episode?: number;
}

function isDebridCdnUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".download.real-debrid.com");
  } catch {
    return false;
  }
}

export async function resolveTorrentioStreamUrl(
  streamUrl: string,
  realDebridToken?: string,
  options?: ResolveTorrentioOptions
): Promise<string> {
  let currentUrl = streamUrl;
  let magnet: string | null = null;

  for (let hop = 0; hop < 8; hop++) {
    const fromUrl = extractMagnetCandidate(currentUrl);
    if (fromUrl) magnet = fromUrl;
    if (isDebridCdnUrl(currentUrl)) break;

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json, */*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
    } catch (err) {
      if (isDebridCdnUrl(currentUrl)) {
        const { markDebridHostUnreachable, withReachableDebridHost } = await import("./real-debrid-api");
        markDebridHostUnreachable(new URL(currentUrl).hostname);
        const swapped = await withReachableDebridHost(currentUrl);
        if (swapped !== currentUrl) {
          currentUrl = swapped;
          break;
        }
      }
      const cause =
        err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
      let host = "the stream host";
      try {
        host = new URL(currentUrl).host;
      } catch {
        /* keep generic host */
      }
      throw new Error(
        `Could not contact ${host}${cause ? ` (${cause})` : ""}. Real-Debrid did not return a playable file.`
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      const fromLocation = extractMagnetCandidate(currentUrl);
      if (fromLocation) magnet = fromLocation;
      if (isDebridCdnUrl(currentUrl)) break;
      continue;
    }

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = (await res.json()) as Record<string, unknown>;
      const next =
        (typeof data.url === "string" ? data.url : "") ||
        (typeof data.download === "string" ? data.download : "") ||
        (typeof data.stream_url === "string" ? data.stream_url : "") ||
        (typeof data.link === "string" ? data.link : "") ||
        (typeof data.magnet === "string" ? data.magnet : "");
      if (typeof data.magnet === "string") magnet = data.magnet;
      if (next.startsWith("http")) {
        currentUrl = next;
        const fromNext = extractMagnetCandidate(next);
        if (fromNext) magnet = fromNext;
        continue;
      }
      if (next.startsWith("magnet:")) {
        magnet = next;
        break;
      }
      throw new Error("Torrent stream resolver returned JSON without a download URL");
    }

    if (contentType.includes("text/html") || contentType.includes("text/plain")) {
      const text = await res.text();
      const fromBody = extractMagnetCandidate(text);
      if (fromBody) {
        magnet = fromBody;
        break;
      }
      const snippet = text.slice(0, 256).toLowerCase();
      if (snippet.includes("<!doctype") || snippet.includes("<html")) {
        throw new Error(
          "Stream not ready on Real-Debrid. Choose a cached (⚡) release or try 1080p instead of 4K."
        );
      }
    }

    break;
  }

  if (
    magnet &&
    realDebridToken &&
    options?.season != null &&
    options?.episode != null
  ) {
    const { resolveMagnetStreamForEpisode } = await import("./real-debrid-api");
    const resolved = await resolveMagnetStreamForEpisode(
      realDebridToken,
      magnet,
      options.season,
      options.episode
    );
    return resolved.streamUrl;
  }

  const finalized = await finalizeDebridDownloadUrl(currentUrl, realDebridToken);
  const { withReachableDebridHost } = await import("./real-debrid-api");
  return withReachableDebridHost(finalized);
}

function extractMagnetCandidate(text: string): string | null {
  if (!text) return null;
  if (text.startsWith("magnet:")) return text;
  const match = text.match(/magnet:\?xt=urn:btih:[^\s"'<>]+/i);
  return match ? match[0] : null;
}

async function finalizeDebridDownloadUrl(
  url: string,
  token?: string
): Promise<string> {
  if (!token) return url;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const needsUnrestrict =
      (host === "real-debrid.com" || host === "www.real-debrid.com") &&
      parsed.pathname.includes("/d/");

    if (needsUnrestrict) {
      const { unrestrictLink } = await import("./real-debrid-api");
      const result = await unrestrictLink(token, url);
      return result.download;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Stream not ready")) throw err;
  }

  return url;
}
