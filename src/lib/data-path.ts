import { paths } from "./install/runtime";

/**
 * Folder for accounts, profiles, avatars and per-user state (`<data>/db`). The data directory
 * itself comes from NOTFLIX_DATA_DIR or the OS default (see install/paths.mjs).
 */
export function getDataPath(): string {
  return paths().dbDir;
}
