import fs from "fs";
import { installPaths, resolveDataDir } from "./paths.mjs";
import { readServerConfig, updateServerConfig, type ServerConfig } from "./config.mjs";
import { readEngineSecret, readSecrets, updateSecrets, type InstallSecrets } from "./secrets.mjs";
import { initializeInstall } from "./init.mjs";

export type { ServerConfig, InstallSecrets };

/**
 * Process-wide view of the installation (data directory, config, credentials). Reads are cached
 * and revalidated by file modification time, so edits from another process (the CLI, a second
 * worker) are picked up without a restart.
 */
export function dataDir(): string {
  return resolveDataDir().dataDir;
}

export function paths() {
  return installPaths(dataDir());
}

type Cached<T> = { key: string; value: T };
const g = globalThis as unknown as { __notflixInstall?: { cfg?: Cached<ServerConfig>; sec?: Cached<InstallSecrets>; eng?: Cached<string>; init?: string } };
const cache = (g.__notflixInstall ??= {});

function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${file}|${s.mtimeMs}|${s.size}`;
  } catch {
    return `${file}|missing`;
  }
}

/** Creates folders/secrets once per process and data directory. */
export function ensureInitialized(): void {
  const dir = dataDir();
  if (cache.init === dir) return;
  initializeInstall(dir);
  cache.init = dir;
}

export function serverConfig(): ServerConfig {
  const file = paths().serverConfigFile;
  const key = stamp(file);
  if (cache.cfg?.key === key) return cache.cfg.value;
  const value = readServerConfig(dataDir());
  cache.cfg = { key, value };
  return value;
}

export function updateConfig(mutate: (cfg: ServerConfig) => void): ServerConfig {
  const next = updateServerConfig(dataDir(), mutate);
  cache.cfg = undefined;
  return next;
}

export function secrets(): InstallSecrets {
  const file = paths().secretsFile;
  const key = stamp(file);
  if (cache.sec?.key === key) return cache.sec.value;
  const value = readSecrets(dataDir());
  cache.sec = { key, value };
  return value;
}

export function saveSecrets(patch: Partial<InstallSecrets>): InstallSecrets {
  const next = updateSecrets(dataDir(), patch);
  cache.sec = undefined;
  return next;
}

export function engineSecret(): string {
  const file = paths().engineSecretFile;
  const key = stamp(file);
  if (cache.eng?.key === key) return cache.eng.value;
  const value = process.env.MEDIA_ENGINE_SECRET?.trim() || readEngineSecret(dataDir());
  cache.eng = { key, value };
  return value;
}

/** Session/profile cookie signing key. Generated on first start; never a built-in default. */
export function sessionSecret(): string {
  let s = secrets().sessionSecret;
  if (!s) {
    ensureInitialized();
    s = saveSecrets({}).sessionSecret;
  }
  return s;
}

export function setupComplete(): boolean {
  return serverConfig().setup.completed;
}
