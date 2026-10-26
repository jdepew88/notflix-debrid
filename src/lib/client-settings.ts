import type { AppSettings } from "./types";

/** Settings live on the server; this fetch helper keeps older call sites working. */
export async function fetchWithSettings(url: string, _settings?: Partial<AppSettings>, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, credentials: "same-origin" });
}

export async function loadClientSettings(): Promise<{ settings: AppSettings; canManageServer: boolean } | null> {
  try {
    const res = await fetch("/api/settings/sync", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as { settings: AppSettings; canManageServer: boolean };
  } catch {
    return null;
  }
}
