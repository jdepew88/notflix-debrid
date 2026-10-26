import "server-only";
import type { MediaItem } from "./types";
import { certificationAllowed, isRestricted, type MaturityLevel } from "./maturity";
import { tmdbRequest } from "./tmdb";

/**
 * US certifications from TMDB, cached in memory (ratings rarely change). Used only for restricted
 * profiles, so unrestricted browsing never pays for these lookups.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; cert: string | null }>();
const inflight = new Map<string, Promise<string | null>>();
const CONCURRENCY = 6;

type Media = "movie" | "tv";

async function fetchCertification(apiKey: string, id: number, media: Media): Promise<string | null> {
  const { url, headers } = tmdbRequest(media === "movie" ? `/movie/${id}/release_dates` : `/tv/${id}/content_ratings`, apiKey);
  const res = await fetch(url, { headers, next: { revalidate: 86_400 } });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  if (media === "movie") {
    const data = (await res.json()) as { results?: Array<{ iso_3166_1: string; release_dates: Array<{ certification: string; type: number }> }> };
    const us = data.results?.find((r) => r.iso_3166_1 === "US");
    // Prefer the theatrical (3) / limited (2) rating, then any non-empty US certification.
    const dates = us?.release_dates ?? [];
    const ranked = [...dates].sort((a, b) => Number(b.type === 3 || b.type === 2) - Number(a.type === 3 || a.type === 2));
    return ranked.find((d) => d.certification?.trim())?.certification.trim() || null;
  }
  const data = (await res.json()) as { results?: Array<{ iso_3166_1: string; rating: string }> };
  return data.results?.find((r) => r.iso_3166_1 === "US")?.rating?.trim() || null;
}

export async function getCertification(apiKey: string, id: number, media: Media): Promise<string | null> {
  const key = `${media}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cert;
  const running = inflight.get(key);
  if (running) return running;
  const task = fetchCertification(apiKey, id, media)
    .then((cert) => {
      cache.set(key, { at: Date.now(), cert });
      return cert;
    })
    // A failed lookup counts as "unknown" (hidden for restricted profiles) and is not cached.
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

function mediaOf(item: MediaItem): Media | null {
  if (item.mediaType === "movie" || item.mediaType === "tv") return item.mediaType;
  if (item.type === "movie") return "movie";
  if (item.type === "series" || item.type === "episode") return "tv";
  return null;
}

/** Keeps the titles a restricted profile may see (rating known and within its level). */
export async function filterForMaturity<T extends MediaItem>(items: T[], level: MaturityLevel, apiKey: string | undefined): Promise<T[]> {
  if (!isRestricted(level)) return items;
  const results: Array<T | null> = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      let cert = item.certification ?? null;
      const media = mediaOf(item);
      if (!cert && apiKey && item.tmdbId && media) cert = await getCertification(apiKey, item.tmdbId, media);
      if (certificationAllowed(cert, level)) results[index] = { ...item, certification: cert ?? undefined };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results.filter((x): x is T => x !== null);
}

/** Whether a single title may be opened or played at this level. */
export async function titleAllowed(level: MaturityLevel, apiKey: string | undefined, tmdbId: number | undefined, media: Media, knownCert?: string | null): Promise<boolean> {
  if (!isRestricted(level)) return true;
  let cert = knownCert ?? null;
  if (!cert && apiKey && tmdbId) cert = await getCertification(apiKey, tmdbId, media);
  return certificationAllowed(cert, level);
}

export const RESTRICTED_RESPONSE = {
  error: "This title isn't available on this profile.",
  code: "maturity_restricted",
} as const;
