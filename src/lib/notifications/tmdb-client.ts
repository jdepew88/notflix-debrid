/**
 * TMDB access for the background jobs: responses cached in memory, requests spaced out (TMDB
 * allows roughly 40-50 per second; jobs stay far below that), bounded retries with backoff for
 * temporary failures (network, 429, 5xx; Retry-After honored). A rejected key fails at once.
 * The key never leaves the server and is never logged; v4 tokens go in a header (tmdbRequest).
 */
import { tmdbRequest } from "../tmdb";

export class TmdbAuthError extends Error {
  constructor() {
    super("TMDB rejected the stored key");
    this.name = "TmdbAuthError";
  }
}

export class TmdbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmdbUnavailableError";
  }
}

export interface TmdbClient {
  get<T>(path: string, ttlMs?: number): Promise<T>;
  /** Requests sent to TMDB (cache hits excluded); for tests and logs. */
  readonly requests: number;
}

export interface TmdbClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Minimum gap between two requests. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cacheMax?: number;
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60_000;

export function createTmdbClient(opts: TmdbClientOptions): TmdbClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const minInterval = opts.minIntervalMs ?? 100;
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const cacheMax = opts.cacheMax ?? 1000;
  const cache = new Map<string, { at: number; ttl: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  let nextSlot = 0;
  let requests = 0;

  async function slot() {
    const t = now();
    const wait = Math.max(0, nextSlot - t);
    nextSlot = Math.max(t, nextSlot) + minInterval;
    if (wait > 0) await sleep(wait);
  }

  async function load(path: string): Promise<unknown> {
    let lastError: Error = new TmdbUnavailableError("TMDB could not be reached");
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1));
      await slot();
      requests++;
      const { url, headers } = tmdbRequest(path, opts.apiKey);
      let res: Response;
      try {
        // no-store: the key may be part of the URL and must not land in Next.js's data cache.
        res = await fetchImpl(url, { headers, cache: "no-store", signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      } catch {
        lastError = new TmdbUnavailableError("TMDB could not be reached");
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 401) throw new TmdbAuthError();
      if (res.status === 404) throw new TmdbUnavailableError(`TMDB has no ${path.split("?")[0]}`);
      if (res.status === 429 || res.status >= 500) {
        lastError = new TmdbUnavailableError(`TMDB answered HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter, 30) * 1000);
        continue;
      }
      throw new TmdbUnavailableError(`TMDB answered HTTP ${res.status}`);
    }
    throw lastError;
  }

  return {
    get requests() {
      return requests;
    },
    async get<T>(path: string, ttlMs = DEFAULT_TTL_MS): Promise<T> {
      const hit = cache.get(path);
      if (hit && now() - hit.at < hit.ttl) return hit.value as T;
      const running = inflight.get(path);
      if (running) return running as Promise<T>;
      const task = load(path)
        .then((value) => {
          cache.set(path, { at: now(), ttl: ttlMs, value });
          if (cache.size > cacheMax) for (const k of [...cache.keys()].slice(0, cache.size - cacheMax)) cache.delete(k);
          return value;
        })
        .finally(() => inflight.delete(path));
      inflight.set(path, task);
      return task as Promise<T>;
    },
  };
}
