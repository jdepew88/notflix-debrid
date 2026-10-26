/**
 * Debrid provider abstraction. The player, source search and media engine only talk to this
 * interface, so another service (AllDebrid, Premiumize, TorBox…) can be added later by
 * implementing it — without touching playback. Only Real-Debrid is implemented in this edition.
 *
 * Credentials stay on the server: implementations read them from the installation's secret store
 * and never return them. Browsers and TV clients only ever see account status.
 */
import type { SourceAddon } from "../play-resolve";

export type DebridProviderId = "real-debrid";

export interface DebridAccountStatus {
  configured: boolean;
  status: "active" | "not-premium" | "invalid-token" | "unreachable" | "not-configured" | "error";
  username?: string;
  premium?: boolean;
  expiration?: string;
  daysLeft?: number;
  message: string;
}

export interface ResolvedStream {
  /** Direct CDN URL of the file (handed only to the private media engine). */
  streamUrl: string;
  filename: string;
}

/** Release-search addons the owner may enable (each is a Stremio-compatible addon). */
export interface SourceAddonChoice {
  id: "torrentio" | "peerflix" | "custom";
  name: string;
  /** Shown during setup: what the addon receives and why. */
  disclosure: string;
}

export interface SourceSelection {
  torrentio: boolean;
  peerflix: boolean;
  custom: boolean;
  customUrl?: string;
}

export interface DebridProvider {
  readonly id: DebridProviderId;
  readonly displayName: string;
  /** Where users create the credential this provider needs. */
  readonly credentialHelpUrl: string;
  readonly credentialLabel: string;
  /** Host suffixes of the provider's download CDN (the media engine's fetch allowlist). */
  readonly cdnHostSuffixes: readonly string[];
  readonly sourceAddonChoices: readonly SourceAddonChoice[];

  isConfigured(): boolean;
  /** Validates a credential (the stored one when omitted) without revealing it. */
  checkAccount(credential?: string): Promise<DebridAccountStatus>;
  /** Addon URLs for release search, with this provider's credential embedded where required. */
  sourceAddons(selection: SourceSelection): SourceAddon[];
  /** Turns a release link from a source addon into a direct, cached CDN URL. */
  resolveReleaseLink(link: string, opts?: { season?: number; episode?: number; fresh?: boolean }): Promise<string>;
  /** Resolves a torrent already in the user's account (Browse → My downloads). */
  resolveAccountTorrent(torrentId: string, opts?: { season?: number; episode?: number }): Promise<ResolvedStream>;
  /** True when `url` points at this provider's download CDN. */
  isCdnUrl(url: string): boolean;
}
