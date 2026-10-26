export interface StremioStream {
  name?: string;
  title?: string;
  url?: string;
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
    proxyHeaders?: Record<string, string>;
  };
}

export interface StremioStreamResponse {
  streams: StremioStream[];
}

export function normalizeStremioBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/manifest\.json$/i, "")
    .replace(/\/$/, "");
}

/** Append Torrentio/Peerflix `language=english` when missing from a configure URL. */
export function ensureEnglishInStremioAddonUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || /language=english/i.test(trimmed)) return trimmed;

  const base = trimmed.replace(/\/manifest\.json$/i, "").replace(/\/$/, "");
  if (base.includes("|")) return `${base}|language=english`;
  return `${base}/language=english`;
}

/** Torrentio `qualityfilter` lists qualities to exclude — keep cam/telesync/screener available. */
export function ensureCamTelesyncAllowedInTorrentioUrl(url: string): string {
  const parts = url.split("|");
  const next: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!lower.startsWith("qualityfilter=")) {
      next.push(part);
      continue;
    }

    const excluded = part
      .slice("qualityfilter=".length)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .filter(
        (value) =>
          !["cam", "scr", "screener", "ts", "telesync", "telecine"].includes(value)
      );

    if (excluded.length > 0) {
      next.push(`qualityfilter=${excluded.join(",")}`);
    }
  }

  return next.join("|");
}

export function finalizeStremioAddonUrl(url: string): string {
  if (!url.trim()) return "";
  const withEnglish = ensureEnglishInStremioAddonUrl(normalizeStremioBaseUrl(url));
  return ensureCamTelesyncAllowedInTorrentioUrl(withEnglish);
}

export async function fetchStremioStreams(
  baseUrl: string,
  type: "movie" | "series",
  videoId: string
): Promise<StremioStream[]> {
  const root = normalizeStremioBaseUrl(baseUrl);
  const url = `${root}/stream/${type}/${encodeURIComponent(videoId)}.json`;

  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Notflix/1.0" },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text.trimStart().toLowerCase().startsWith("<!doctype")) {
      throw new Error("Addon returned an error page. Check addon URL and credentials.");
    }
    throw new Error(`Addon error (${res.status}): ${text.slice(0, 200)}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error("Addon returned HTML instead of stream list. Check configuration.");
  }

  const data = (await res.json()) as StremioStreamResponse;
  return data.streams ?? [];
}

const QUALITY_ORDER = ["4k", "2160", "1080", "720", "480"];

export interface StremioStreamOption {
  index: number;
  label: string;
  detail: string;
  quality?: string;
  cached: boolean;
  score: number;
  recommended: boolean;
  source?: string;
}

const NON_ENGLISH_MARKERS = [
  "french",
  "german",
  "spanish",
  "espanol",
  "español",
  "castellano",
  "latino",
  "italian",
  "portuguese",
  "russian",
  "hindi",
  "tamil",
  "telugu",
  "japanese",
  "korean",
  "chinese",
  "mandarin",
  "cantonese",
  "vostfr",
  "multi.french",
  "multi-french",
  "multi.spanish",
  "multi-spanish",
];

function streamLabel(stream: StremioStream): string {
  return `${stream.name ?? ""} ${stream.title ?? ""}`.toLowerCase();
}

export function isLikelyEnglishStream(stream: StremioStream): boolean {
  const label = streamLabel(stream);
  if (NON_ENGLISH_MARKERS.some((m) => label.includes(m))) return false;
  if (label.includes("english") || label.includes(" eng ") || /\beng\b/.test(label)) {
    return true;
  }
  if (label.includes("multi")) return true;
  return !/\b(fr|de|es|it|pt|ru|ja|ko|zh)\b/.test(label);
}

/** Prefer releases that usually direct-play in the browser (H.264 + AAC / MP4). */
export function streamDirectPlayScore(stream: StremioStream): number {
  const label = streamLabel(stream);
  let score = streamScore(stream);

  if (label.includes("x264") || label.includes("h264") || label.includes("h.264")) score += 30;
  if (label.includes("aac") || label.includes("2.0")) score += 25;
  if (label.includes(".mp4") || label.includes(" mp4")) score += 18;
  if (label.includes("web-dl") || label.includes("webdl") || label.includes("webrip")) score += 12;

  if (label.includes("hevc") || label.includes("x265") || label.includes("h265")) score -= 18;
  if (label.includes("dts") || label.includes("ac3") || label.includes("eac3") || label.includes("truehd")) {
    score -= 22;
  }
  if (label.includes(".mkv") || label.includes(" mkv")) score -= 8;

  if (label.includes("cam") || label.includes("camrip")) score -= 4;
  if (label.includes("telesync") || label.includes("telecine") || /\bts\b/.test(label)) score -= 2;
  if (label.includes("screener") || label.includes(" scr ")) score -= 3;

  return score;
}

export function streamScore(stream: StremioStream): number {
  const label = streamLabel(stream);
  if (label.includes("download") || label.includes("⬇")) return -100;
  if (stream.behaviorHints?.notWebReady) return -50;
  if (!stream.url?.startsWith("http")) return -200;

  let score = 0;
  for (let i = 0; i < QUALITY_ORDER.length; i++) {
    if (label.includes(QUALITY_ORDER[i])) {
      score += (QUALITY_ORDER.length - i) * 10;
      break;
    }
  }
  if (label.includes("rd") || label.includes("real-debrid") || label.includes("debrid")) {
    score += 5;
  }
  if (label.includes("⚡") || label.includes("cached") || label.includes("instant")) {
    score += 40;
  }
  if (label.includes("aac")) score += 15;
  if (label.includes("x264") || label.includes("h264") || label.includes("h.264")) score += 10;
  if (label.includes("x265") || label.includes("hevc") || label.includes("h265")) score += 6;
  if (label.includes(".mp4") || label.includes(" mp4")) score += 8;
  if (label.includes("english") || label.includes(" eng ")) score += 12;
  return score;
}

function parseStreamQuality(label: string): string | undefined {
  const lower = label.toLowerCase();
  if (lower.includes("telesync") || lower.includes("telecine") || /\bts\b/.test(lower)) {
    return "TS";
  }
  if (lower.includes("camrip") || lower.includes(" cam ") || lower.startsWith("cam ")) {
    return "CAM";
  }
  if (lower.includes("screener") || lower.includes(" scr ")) {
    return "SCR";
  }
  for (const q of ["4k", "2160p", "1080p", "720p", "480p"]) {
    if (lower.includes(q)) return q.toUpperCase().replace("2160P", "4K");
  }
  return undefined;
}

function formatStreamOption(
  stream: StremioStream,
  index: number,
  recommended: boolean,
  source?: string
): StremioStreamOption {
  const rawTitle = (stream.title ?? stream.name ?? "Stream").trim();
  const lines = rawTitle.split("\n").map((l) => l.trim()).filter(Boolean);
  const label = lines[0] || "Stream";
  const detail = lines.slice(1).join(" · ") || rawTitle;
  const combined = `${stream.name ?? ""} ${stream.title ?? ""}`.toLowerCase();
  // Torrentio: "[RD+]" = cached on Real-Debrid (instant), "[RD download]" = must be downloaded first.
  const cached =
    (/\[rd\+\]/.test(combined) || combined.includes("⚡") || /\binstant\b/.test(combined)) &&
    !/\[rd download\]/.test(combined);

  return {
    index,
    label,
    detail,
    quality: parseStreamQuality(combined),
    cached,
    score: streamScore(stream),
    recommended,
    source,
  };
}

export interface ListPlayableStreamsOptions {
  source?: string;
  directPlayPreferred?: boolean;
}

export function listPlayableStremioStreams(
  streams: StremioStream[],
  options: ListPlayableStreamsOptions | string = {}
): {
  playable: StremioStream[];
  options: StremioStreamOption[];
} {
  const opts: ListPlayableStreamsOptions =
    typeof options === "string" ? { source: options } : options;
  const rank = opts.directPlayPreferred ? streamDirectPlayScore : streamScore;

  const playable = streams
    .filter((s) => s.url?.startsWith("http"))
    .filter(isLikelyEnglishStream)
    .sort((a, b) => rank(b) - rank(a));

  const streamOptions = playable.map((stream, index) =>
    formatStreamOption(stream, index, index === 0, opts.source)
  );

  return { playable, options: streamOptions };
}

export function mergeStremioStreamLists(
  lists: Array<{ streams: StremioStream[]; source: string }>,
  options: { directPlayPreferred?: boolean } = {}
): { playable: StremioStream[]; options: StremioStreamOption[] } {
  const seen = new Set<string>();
  const merged: StremioStream[] = [];

  for (const { streams, source } of lists) {
    for (const stream of streams) {
      if (!stream.url || seen.has(stream.url)) continue;
      seen.add(stream.url);
      merged.push({ ...stream, name: stream.name ?? source });
    }
  }

  const { playable, options: streamOptions } = listPlayableStremioStreams(merged, {
    directPlayPreferred: options.directPlayPreferred,
  });
  return {
    playable,
    options: streamOptions.map((opt, index) => ({
      ...opt,
      index,
      recommended: index === 0,
    })),
  };
}
