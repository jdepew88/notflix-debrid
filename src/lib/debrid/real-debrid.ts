import { checkDebridAccount, resolveTorrentStream } from "../real-debrid-api";
import { buildDefaultTorrentioUrl } from "../torrentio";
import { buildDefaultPeerflixUrl } from "../peerflix";
import { finalizeStremioAddonUrl } from "../stremio-streams";
import { resolveDebridLink } from "../source-candidates";
import type { SourceAddon } from "../play-resolve";
import type { DebridAccountStatus, DebridProvider, ResolvedStream, SourceSelection } from "./provider";

/**
 * Real-Debrid, authenticated with the account's private API token
 * (https://real-debrid.com/apitoken). The token is read from the server's secret store on every
 * call, so a token replaced in Settings takes effect immediately.
 */
export class RealDebridProvider implements DebridProvider {
  readonly id = "real-debrid" as const;
  readonly displayName = "Real-Debrid";
  readonly credentialHelpUrl = "https://real-debrid.com/apitoken";
  readonly credentialLabel = "API token";
  readonly cdnHostSuffixes = ["real-debrid.com", "download.real-debrid.com", "real-debrid.fr"] as const;
  readonly sourceAddonChoices = [
    {
      id: "torrentio",
      name: "Torrentio",
      disclosure:
        "Torrentio (torrentio.strem.fun) lists releases and checks which are cached on Real-Debrid. To do that, your Real-Debrid API token is included in the requests Notflix makes to Torrentio's server.",
    },
    {
      id: "peerflix",
      name: "Peerflix",
      disclosure:
        "Peerflix (peerflix.mov) is a second release index. Like Torrentio, it receives your Real-Debrid API token in each request.",
    },
    {
      id: "custom",
      name: "Custom addon",
      disclosure:
        "Any Stremio-compatible stream addon URL you trust (for example a self-hosted one). Everything in the URL, including any token, is sent to that server.",
    },
  ] as const;

  constructor(private readonly token: () => string) {}

  isConfigured(): boolean {
    return Boolean(this.token());
  }

  checkAccount(credential?: string): Promise<DebridAccountStatus> {
    return checkDebridAccount(credential ?? this.token());
  }

  sourceAddons(selection: SourceSelection): SourceAddon[] {
    const token = this.token();
    const out: SourceAddon[] = [];
    if (token && selection.torrentio) out.push({ name: "Torrentio", url: buildDefaultTorrentioUrl(token) });
    if (token && selection.peerflix) out.push({ name: "Peerflix", url: buildDefaultPeerflixUrl(token) });
    if (selection.custom && selection.customUrl?.trim()) {
      out.push({ name: "Custom addon", url: finalizeStremioAddonUrl(selection.customUrl) });
    }
    return out;
  }

  resolveReleaseLink(link: string, opts: { season?: number; episode?: number; fresh?: boolean } = {}): Promise<string> {
    return resolveDebridLink(link, this.token(), opts.season, opts.episode, opts.fresh);
  }

  resolveAccountTorrent(torrentId: string, opts: { season?: number; episode?: number } = {}): Promise<ResolvedStream> {
    return resolveTorrentStream(this.token(), torrentId, opts.season, opts.episode);
  }

  isCdnUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return this.cdnHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
    } catch {
      return false;
    }
  }
}
