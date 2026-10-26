import "server-only";
import crypto from "crypto";
import { secrets, serverConfig } from "./runtime";
import { debridProvider, enabledSourceAddons } from "../debrid";
import { validateTmdbCredential } from "../tmdb";

/** Something the owner must fix. Shown as a banner to the owner only; nothing is reset. */
export interface ConfigAlert {
  id: "tmdb-missing" | "tmdb-rejected" | "debrid-missing" | "debrid-rejected" | "debrid-not-premium" | "no-source";
  message: string;
  /** Settings section or wizard step that fixes it. */
  href: string;
}

const LIVE_TTL_MS = 15 * 60_000;
const g = globalThis as unknown as { __notflixAlerts?: { key: string; at: number; alerts: ConfigAlert[] } };

/**
 * Checks the stored credentials against the providers (cached for 15 minutes per credential, so
 * browsing does not call TMDB/Real-Debrid on every page). A provider that cannot be reached is not
 * reported as a broken credential.
 */
export async function configAlerts(opts: { fresh?: boolean } = {}): Promise<ConfigAlert[]> {
  const cfg = serverConfig();
  if (!cfg.setup.completed) return [];
  const sec = secrets();
  const provider = debridProvider();
  const alerts: ConfigAlert[] = [];
  if (!sec.tmdbApiKey) alerts.push({ id: "tmdb-missing", message: "No TMDB key is stored, so the catalog cannot load.", href: "/settings/wizard#metadata" });
  if (!sec.realDebridToken) {
    alerts.push({ id: "debrid-missing", message: `No ${provider.displayName} ${provider.credentialLabel} is stored, so nothing can play.`, href: "/settings/wizard#debrid" });
  }
  if (enabledSourceAddons().length === 0) alerts.push({ id: "no-source", message: "No release search is enabled, so nothing can play.", href: "/settings/wizard#debrid" });

  const key = crypto.createHash("sha256").update(`${sec.tmdbApiKey}\n${sec.realDebridToken}`).digest("hex");
  const cached = g.__notflixAlerts;
  let live: ConfigAlert[];
  if (!opts.fresh && cached && cached.key === key && Date.now() - cached.at < LIVE_TTL_MS) {
    live = cached.alerts;
  } else {
    live = [];
    const [tmdb, debrid] = await Promise.all([
      sec.tmdbApiKey ? validateTmdbCredential(sec.tmdbApiKey) : Promise.resolve(null),
      sec.realDebridToken ? provider.checkAccount() : Promise.resolve(null),
    ]);
    if (tmdb && tmdb.status === "invalid") {
      live.push({ id: "tmdb-rejected", message: "TMDB no longer accepts the stored key. Paste a new one.", href: "/settings/wizard#metadata" });
    }
    if (debrid?.status === "invalid-token") {
      live.push({ id: "debrid-rejected", message: `${provider.displayName} no longer accepts the stored ${provider.credentialLabel}. Paste a new one.`, href: "/settings/wizard#debrid" });
    } else if (debrid?.status === "not-premium") {
      live.push({ id: "debrid-not-premium", message: `${debrid.message} Streaming needs an active subscription.`, href: "/settings/wizard#debrid" });
    }
    g.__notflixAlerts = { key, at: Date.now(), alerts: live };
  }
  return [...alerts, ...live];
}
