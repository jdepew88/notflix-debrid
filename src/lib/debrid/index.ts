import "server-only";
import { secrets, serverConfig } from "../install/runtime";
import type { SourceAddon } from "../play-resolve";
import type { DebridProvider } from "./provider";
import { RealDebridProvider } from "./real-debrid";

export type { DebridProvider, DebridAccountStatus, ResolvedStream, SourceSelection } from "./provider";

let provider: DebridProvider | null = null;

/** The configured debrid provider (Real-Debrid is the only one in this edition). */
export function debridProvider(): DebridProvider {
  return (provider ??= new RealDebridProvider(() => secrets().realDebridToken));
}

/** Release-search addons enabled by the owner, ready for a source search. Server-side only. */
export function enabledSourceAddons(): SourceAddon[] {
  const sources = serverConfig().debrid.sources;
  return debridProvider().sourceAddons({ ...sources, customUrl: secrets().customSourceUrl });
}
