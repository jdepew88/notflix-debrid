import type { MediaItem } from "./types";

export type StreamingServiceFilterId =
  | "all"
  | "netflix"
  | "prime"
  | "hulu"
  | "disney"
  | "max"
  | "apple"
  | "peacock"
  | "paramount";

export interface StreamingServiceFilter {
  id: StreamingServiceFilterId;
  label: string;
}

/** Browse filter chips — order matches common US streaming apps. */
export const STREAMING_SERVICE_FILTERS: StreamingServiceFilter[] = [
  { id: "all", label: "All" },
  { id: "netflix", label: "Netflix" },
  { id: "prime", label: "Prime Video" },
  { id: "hulu", label: "Hulu" },
  { id: "disney", label: "Disney+" },
  { id: "max", label: "Max" },
  { id: "apple", label: "Apple TV+" },
  { id: "peacock", label: "Peacock" },
  { id: "paramount", label: "Paramount+" },
];

/** TMDB watch provider IDs for US discover API (`with_watch_providers`). */
export const TMDB_PROVIDER_IDS: Record<
  Exclude<StreamingServiceFilterId, "all">,
  number
> = {
  netflix: 8,
  prime: 9,
  hulu: 15,
  disney: 337,
  max: 1899,
  apple: 350,
  peacock: 386,
  paramount: 531,
};

export function getTmdbProviderId(
  serviceId: StreamingServiceFilterId
): number | undefined {
  if (serviceId === "all") return undefined;
  return TMDB_PROVIDER_IDS[serviceId];
}

/** TMDB flatrate provider_name values (and aliases) per filter. */
const FLATRATE_NAME_MATCHERS: Record<
  Exclude<StreamingServiceFilterId, "all">,
  string[]
> = {
  netflix: ["Netflix"],
  prime: ["Amazon Prime Video", "Prime Video"],
  hulu: ["Hulu"],
  disney: ["Disney Plus", "Disney+"],
  max: ["Max", "HBO Max"],
  apple: ["Apple TV Plus", "Apple TV+"],
  peacock: ["Peacock", "Peacock Premium"],
  paramount: ["Paramount Plus", "Paramount+"],
};

function normalizeProviderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flatrateNames(item: MediaItem): string[] {
  return item.watchProviders?.flatrate?.map((p) => p.name) ?? [];
}

export function itemMatchesStreamingService(
  item: MediaItem,
  serviceId: StreamingServiceFilterId
): boolean {
  if (serviceId === "all") return true;

  const names = flatrateNames(item);
  if (names.length === 0) return false;

  const matchers = FLATRATE_NAME_MATCHERS[serviceId].map(normalizeProviderName);
  return names.some((name) => {
    const normalized = normalizeProviderName(name);
    return matchers.some(
      (matcher) => normalized === matcher || normalized.includes(matcher)
    );
  });
}

export function filterRowItems(
  items: MediaItem[],
  serviceId: StreamingServiceFilterId
): MediaItem[] {
  if (serviceId === "all") return items;
  return items.filter((item) => itemMatchesStreamingService(item, serviceId));
}

/** Rows kept visible when a streaming-service chip is active. */
export const STREAMING_FILTER_EXEMPT_ROW_IDS = new Set(["continue-watching"]);

export function getStreamingServiceLabel(
  serviceId: StreamingServiceFilterId
): string {
  return (
    STREAMING_SERVICE_FILTERS.find((f) => f.id === serviceId)?.label ?? serviceId
  );
}
