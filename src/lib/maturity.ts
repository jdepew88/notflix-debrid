/**
 * Profile maturity policy. Ratings are US certifications (TMDB `release_dates` for films,
 * `content_ratings` for TV). A restricted profile only sees titles whose rating is known and within
 * its level: unrated or unknown titles are hidden, never assumed to be suitable.
 */
export type MaturityLevel = "little-kids" | "kids" | "teens" | "all";

export const MATURITY_LEVELS: Array<{ value: MaturityLevel; label: string; description: string }> = [
  { value: "little-kids", label: "Little kids", description: "G, TV-Y, TV-G" },
  { value: "kids", label: "Older kids", description: "Up to PG, TV-Y7, TV-PG" },
  { value: "teens", label: "Teens", description: "Up to PG-13, TV-14" },
  { value: "all", label: "All maturity ratings", description: "Everything, including R, NC-17 and TV-MA" },
];

const MAX_RANK: Record<MaturityLevel, number> = { "little-kids": 0, kids: 1, teens: 2, all: Number.POSITIVE_INFINITY };

const RANK: Record<string, number> = {
  G: 0,
  "TV-Y": 0,
  "TV-G": 0,
  PG: 1,
  "TV-Y7": 1,
  "TV-Y7-FV": 1,
  "TV-PG": 1,
  "PG-13": 2,
  "TV-14": 2,
  R: 3,
  "TV-MA": 3,
  "NC-17": 4,
};

export function isMaturityLevel(value: unknown): value is MaturityLevel {
  return value === "little-kids" || value === "kids" || value === "teens" || value === "all";
}

/** Effective level for a profile: an explicit setting, else "kids" for kids profiles, else "all". */
export function profileMaturity(profile: { isKids?: boolean; maturity?: string } | null | undefined): MaturityLevel {
  if (profile && isMaturityLevel(profile.maturity)) {
    // A kids profile can never be widened to "all" by a stale or hand-edited value.
    if (profile.isKids && profile.maturity === "all") return "kids";
    return profile.maturity;
  }
  return profile?.isKids ? "kids" : "all";
}

export function isRestricted(level: MaturityLevel): boolean {
  return level !== "all";
}

/** The strictest of several levels (used when the browser has not chosen a profile yet). */
export function strictestLevel(levels: MaturityLevel[]): MaturityLevel {
  if (levels.length === 0) return "all";
  return levels.reduce((a, b) => (MAX_RANK[b] < MAX_RANK[a] ? b : a));
}

export function certificationRank(cert: string | null | undefined): number | null {
  if (!cert) return null;
  const rank = RANK[cert.trim().toUpperCase()];
  return rank === undefined ? null : rank;
}

/** Whether a title with this certification may be shown at this level. Unknown → only for "all". */
export function certificationAllowed(cert: string | null | undefined, level: MaturityLevel): boolean {
  if (level === "all") return true;
  const rank = certificationRank(cert);
  return rank !== null && rank <= MAX_RANK[level];
}
