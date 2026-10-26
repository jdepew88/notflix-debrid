/** Peerflix: a Stremio-compatible release index (opt-in source addon). */
export const DEFAULT_PEERFLIX_BASE = "https://peerflix.mov";

export function buildDefaultPeerflixUrl(realDebridToken?: string): string {
  const parts: string[] = ["language=english"];
  if (realDebridToken) {
    parts.unshift(`realdebrid=${encodeURIComponent(realDebridToken)}`);
  }
  return `${DEFAULT_PEERFLIX_BASE}/${parts.join("|")}`;
}
