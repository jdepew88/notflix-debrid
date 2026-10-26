#!/usr/bin/env node
/**
 * Prepares a THROWAWAY, already-set-up installation for the browser test suite (Playwright):
 *
 *   node scripts/prepare-test-instance.mjs --data <empty folder> --web-port 8529 --engine-port 8528
 *
 * - owner account "e2e-owner" (no display name, so its first profile is "Main"),
 * - setup marked complete and self-service sign-up open (the suite creates many accounts),
 * - TMDB: the key from NOTFLIX_TEST_TMDB_KEY when set (real catalog tests can run); otherwise a
 *   placeholder, and catalog/details tests will fail against TMDB (reported, not hidden),
 * - Real-Debrid: NOTFLIX_TEST_RD_TOKEN when set, else a placeholder (playback of real titles is
 *   then only covered by the self-test samples).
 * - --credentials-from <data folder>: instead of the variables, reuse the TMDB/Real-Debrid
 *   credentials an owner entered through onboarding in another installation of this edition. They
 *   are decrypted and re-encrypted in-process (same Windows account) and never printed.
 * Never point --data at a real installation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeInstall, removeSetupCode } from "../src/lib/install/init.mjs";
import { ensureEngineLibraryRoot, updateEngineConfig, updateServerConfig } from "../src/lib/install/config.mjs";
import { readSecrets, updateSecrets } from "../src/lib/install/secrets.mjs";
import { installPaths } from "../src/lib/install/paths.mjs";
import { writeJsonAtomic } from "../src/lib/install/store.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const dataDir = opt("--data");
if (!dataDir) throw new Error("--data <empty folder> is required");
if (fs.existsSync(path.join(dataDir, "db", "users.json"))) throw new Error(`${dataDir} already holds accounts; use an empty folder`);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

initializeInstall(dataDir);
ensureEngineLibraryRoot(dataDir, path.join(appRoot, "test-media"));
updateEngineConfig(dataDir, { port: Number(opt("--engine-port", "8528")) });

const password = opt("--owner-password", "e2e-owner-pass");
const N = 2 ** 17;
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 32 * 1024 * 1024 });
writeJsonAtomic(path.join(installPaths(dataDir).dbDir, "users.json"), {
  users: [
    {
      id: crypto.randomUUID(),
      name: "e2e-owner",
      passwordHash: `scrypt$${N},8,1$${salt.toString("base64url")}$${hash.toString("base64url")}`,
      createdAt: new Date().toISOString(),
      role: "owner",
      sessionVersion: 0,
    },
  ],
});
removeSetupCode(dataDir);

const from = opt("--credentials-from");
const borrowed = from ? readSecrets(path.resolve(from)) : null;
if (from && path.resolve(from).toLowerCase() === path.resolve(dataDir).toLowerCase()) throw new Error("--credentials-from must be another folder");
if (from && !borrowed?.tmdbApiKey) throw new Error(`no readable TMDB credential in ${from}`);
const tmdb = borrowed?.tmdbApiKey || process.env.NOTFLIX_TEST_TMDB_KEY?.trim();
const rd = borrowed?.realDebridToken || process.env.NOTFLIX_TEST_RD_TOKEN?.trim();
updateSecrets(dataDir, { tmdbApiKey: tmdb || "PLACEHOLDER-TMDB-KEY", realDebridToken: rd || "PLACEHOLDERREALDEBRIDTOKEN000000" });
const now = new Date().toISOString();
updateServerConfig(dataDir, (c) => {
  c.server.port = Number(opt("--web-port", "8529"));
  c.setup.completed = true;
  c.setup.completedAt = now;
  c.setup.ownerCreatedAt = now;
  c.setup.stepsDone = ["server", "owner", "metadata", "debrid", "hardware"];
  c.accounts.allowSignup = true;
  c.metadata.tmdbValidatedAt = now;
  c.debrid.validatedAt = now;
  c.debrid.account = rd ? null : "placeholder";
});
console.log(JSON.stringify({ dataDir, owner: "e2e-owner", realTmdb: Boolean(tmdb), realDebrid: Boolean(rd) }));
