/** Build Chromecast- and AirPlay-friendly absolute media URLs. */

export function getAppOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || "";
}

export function toAbsoluteMediaUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const origin = getAppOrigin();
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

export function withQueryParam(url: string, key: string, value: string): string {
  const absolute = toAbsoluteMediaUrl(url);
  const parsed = new URL(absolute);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

export function isHlsSource(src: string): boolean {
  return (
    // Media-engine HLS sessions (/api/playback/{id}/manifest?generation=N).
    /\/api\/playback\/[a-f0-9]+\/manifest/.test(src) ||
    src.includes(".m3u8")
  );
}

export function isSafariBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|OPR|Firefox|FxiOS/i.test(ua);
}

export interface CastMediaDescriptor {
  url: string;
  contentType: string;
  streamType: "BUFFERED" | "LIVE";
}

export function buildCastMediaDescriptor(src: string): CastMediaDescriptor {
  const url = toAbsoluteMediaUrl(src);
  return {
    url,
    contentType: isHlsSource(url) ? "application/x-mpegURL" : "video/mp4",
    streamType: "BUFFERED",
  };
}

export function buildRemotePlaybackUrl(src: string): string {
  return toAbsoluteMediaUrl(src);
}
