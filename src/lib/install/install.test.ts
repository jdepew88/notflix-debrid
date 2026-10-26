import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DATA_DIR_POINTER, cacheDirProblem, defaultDataDir, installPaths, resolveDataDir } from "./paths.mjs";
import { DEFAULT_WEB_PORT, bindAddressFor, normalizeServerConfig, readEngineConfig, readServerConfig, updateEngineConfig, updateServerConfig } from "./config.mjs";
import { ensureInstallSecrets, readEngineSecret, readSecrets, rotateSecretsKey, secretHint, secretsStatus, updateSecrets } from "./secrets.mjs";
import { initializeInstall, readSetupCode } from "./init.mjs";
import { withFileLock } from "./store.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-install-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const fresh = (name: string) => {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe("storage paths", () => {
  it("use OS-appropriate defaults, never the source tree", () => {
    expect(defaultDataDir("win32", { ProgramData: "C:\\ProgramData" })).toBe("C:\\ProgramData\\NotflixDebrid");
    expect(defaultDataDir("darwin", { HOME: "/Users/alex" })).toBe("/Users/alex/Library/Application Support/NotflixDebrid");
    expect(defaultDataDir("linux", { HOME: "/home/alex" }, () => true)).toBe("/var/lib/notflix-debrid");
    expect(defaultDataDir("linux", { HOME: "/home/alex" }, () => false)).toBe("/home/alex/.local/share/notflix-debrid");
    expect(defaultDataDir("linux", { HOME: "/home/alex", XDG_DATA_HOME: "/data/xdg" }, () => false)).toBe("/data/xdg/notflix-debrid");
  });

  it("prefer NOTFLIX_DATA_DIR, then the pointer file, then the default", () => {
    const app = fresh("app-root");
    const pointed = path.join(scratch, "pointed-data");
    expect(resolveDataDir({ env: {}, appRoot: app }).source).toBe("default");
    fs.writeFileSync(path.join(app, DATA_DIR_POINTER), pointed + "\n");
    expect(resolveDataDir({ env: {}, appRoot: app })).toEqual({ dataDir: path.resolve(pointed), source: "pointer" });
    expect(resolveDataDir({ env: { NOTFLIX_DATA_DIR: path.join(scratch, "env-data") }, appRoot: app }).source).toBe("env");
    // A relative pointer (hand-edited) is ignored rather than resolved against an unknown cwd.
    fs.writeFileSync(path.join(app, DATA_DIR_POINTER), "relative/dir");
    expect(resolveDataDir({ env: {}, appRoot: app }).source).toBe("default");
  });

  it("refuse cache folders that could delete settings, accounts, credentials or the app", () => {
    const data = path.join(scratch, "data-for-cache");
    const p = installPaths(data);
    const ctx = { dataDir: data, appRoot: path.join(scratch, "app") };
    expect(cacheDirProblem(p.defaultCacheDir, ctx)).toBeNull();
    expect(cacheDirProblem(path.join(scratch, "elsewhere", "cache"), ctx)).toBeNull();
    expect(cacheDirProblem(data, ctx)).not.toBeNull();
    expect(cacheDirProblem(p.secretsDir, ctx)).not.toBeNull();
    expect(cacheDirProblem(path.join(p.dbDir, "cache"), ctx)).not.toBeNull();
    expect(cacheDirProblem(path.dirname(data), ctx)).not.toBeNull(); // contains the data folder
    expect(cacheDirProblem(path.parse(scratch).root, ctx)).not.toBeNull();
    expect(cacheDirProblem("relative/cache", ctx)).not.toBeNull();
    expect(cacheDirProblem(path.join(scratch, "app", "cache"), ctx)).not.toBeNull();
  });
});

describe("server config", () => {
  it("falls back to safe defaults for missing or malformed values", () => {
    const data = fresh("cfg-normalize");
    const cfg = normalizeServerConfig(
      { server: { port: 80, allowLan: "yes", hostname: "bad host!", publicUrl: "javascript:alert(1)", bindAddress: "evil" }, storage: { cacheDirectory: "rel", cacheMaxGiB: -5 } },
      data
    );
    expect(cfg.server.port).toBe(DEFAULT_WEB_PORT);
    expect(cfg.server.allowLan).toBe(false);
    expect(cfg.server.hostname).toBe("");
    expect(cfg.server.publicUrl).toBe("");
    expect(cfg.server.bindAddress).toBe("");
    expect(cfg.storage.cacheDirectory).toBe(installPaths(data).defaultCacheDir);
    expect(cfg.storage.cacheMaxGiB).toBe(1);
    expect(cfg.setup.completed).toBe(false);
    expect(cfg.accounts.allowSignup).toBe(false);
    expect(cfg.debrid.sources).toEqual({ torrentio: true, peerflix: false, custom: false });
  });

  it("listens on loopback only until LAN access is allowed", () => {
    const data = fresh("cfg-bind");
    const cfg = readServerConfig(data);
    expect(bindAddressFor(cfg)).toBe("127.0.0.1");
    expect(bindAddressFor({ ...cfg, server: { ...cfg.server, allowLan: true } })).toBe("0.0.0.0");
  });

  it("persists across reads (restart) and keeps the engine's storage in sync", () => {
    const data = fresh("cfg-persist");
    updateServerConfig(data, (c) => {
      c.server.port = 9123;
      c.storage.cacheMaxGiB = 25;
    });
    expect(readServerConfig(data).server.port).toBe(9123);
    const engine = updateEngineConfig(data, { hardwareAcceleration: "amf", hardwareDevice: "1" });
    expect(engine.cacheMaxBytes).toBe(25 * 1024 ** 3);
    expect(engine.bindAddress).toBe("127.0.0.1");
    expect(readEngineConfig(data).hardwareAcceleration).toBe("amf");
    // An unknown backend in a hand-edited file falls back to automatic selection.
    fs.writeFileSync(installPaths(data).engineConfigFile, JSON.stringify({ hardwareAcceleration: "quantum" }));
    expect(readEngineConfig(data).hardwareAcceleration).toBe("auto");
  });
});

describe("secrets", () => {
  it("are generated once, never regenerated, and kept out of the config folder", () => {
    const data = fresh("secrets");
    const first = ensureInstallSecrets(data);
    expect(first).toMatchObject({ createdSession: true, createdEngine: true, recovered: null });
    const session = readSecrets(data).sessionSecret;
    const engine = readEngineSecret(data);
    expect(session.length).toBeGreaterThanOrEqual(40);
    expect(engine.length).toBeGreaterThanOrEqual(32);
    expect(ensureInstallSecrets(data)).toEqual({ createdSession: false, createdEngine: false, migrated: false, recovered: null });
    expect(readSecrets(data).sessionSecret).toBe(session);
    updateSecrets(data, { realDebridToken: "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    expect(readSecrets(data).sessionSecret).toBe(session);
    updateServerConfig(data, () => {});
    updateEngineConfig(data, {});
    const configText = fs.readdirSync(installPaths(data).configDir).map((f) => fs.readFileSync(path.join(installPaths(data).configDir, f), "utf8")).join("");
    expect(configText).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(secretHint("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe("…2345");
    expect(secretHint("")).toBe("");
  });
});

// Real DPAPI on Windows (the test runs as a normal user account); other systems store plaintext
// with owner-only permissions, which these tests also cover.
describe("credential encryption at rest", () => {
  const win = process.platform === "win32";
  const TOKEN = "RDTOKENVALUE0123456789ABCDEFGHIJKLMNOP";
  const KEY = "tmdbkeyvalue0123456789abcdef0123";
  const file = (data: string) => installPaths(data).secretsFile;

  it("never writes credential values in clear text and reads them back", () => {
    const data = fresh("enc-basic");
    ensureInstallSecrets(data);
    updateSecrets(data, { tmdbApiKey: KEY, realDebridToken: TOKEN });
    const disk = fs.readFileSync(file(data), "utf8");
    const status = secretsStatus(data);
    if (win) {
      expect(status).toMatchObject({ protection: "dpapi-user", state: "ok" });
      expect(disk).not.toContain(TOKEN);
      expect(disk).not.toContain(KEY);
      expect(disk).not.toContain(readSecrets(data).sessionSecret);
    } else {
      expect(status.protection).toBe("none");
    }
    expect(readSecrets(data)).toMatchObject({ tmdbApiKey: KEY, realDebridToken: TOKEN });
  });

  it("encrypts a phase-1 plaintext store on start, keeping every value", () => {
    const data = fresh("enc-migrate");
    fs.mkdirSync(installPaths(data).secretsDir, { recursive: true });
    fs.writeFileSync(file(data), JSON.stringify({ sessionSecret: "legacy-session-secret-0123456789abcdef", tmdbApiKey: KEY, realDebridToken: TOKEN, customSourceUrl: "" }));
    expect(secretsStatus(data).protection).toBe("plaintext-legacy");
    const r = ensureInstallSecrets(data);
    expect(r.migrated).toBe(win);
    expect(readSecrets(data)).toMatchObject({ sessionSecret: "legacy-session-secret-0123456789abcdef", tmdbApiKey: KEY, realDebridToken: TOKEN });
    if (win) expect(fs.readFileSync(file(data), "utf8")).not.toContain(TOKEN);
  });

  it("rotates a credential and rotates the key without losing other values", () => {
    const data = fresh("enc-rotate");
    ensureInstallSecrets(data);
    updateSecrets(data, { tmdbApiKey: KEY, realDebridToken: TOKEN });
    const session = readSecrets(data).sessionSecret;
    updateSecrets(data, { realDebridToken: "NEWTOKEN" + TOKEN.slice(8) });
    expect(readSecrets(data)).toMatchObject({ tmdbApiKey: KEY, realDebridToken: "NEWTOKEN" + TOKEN.slice(8), sessionSecret: session });
    if (!win) return;
    const before = JSON.parse(fs.readFileSync(file(data), "utf8")).wrappedKey;
    rotateSecretsKey(data);
    const after = JSON.parse(fs.readFileSync(file(data), "utf8")).wrappedKey;
    expect(after).not.toBe(before);
    expect(readSecrets(data)).toMatchObject({ tmdbApiKey: KEY, sessionSecret: session });
  });

  it.runIf(win)("keeps a store it cannot decrypt aside and starts clean (recovery)", () => {
    const data = fresh("enc-recover");
    ensureInstallSecrets(data);
    updateSecrets(data, { realDebridToken: TOKEN });
    // Simulates a data folder restored under another Windows account: the wrapped key is not ours.
    const f = JSON.parse(fs.readFileSync(file(data), "utf8"));
    f.wrappedKey = Buffer.from("not a dpapi blob from this account").toString("base64");
    fs.writeFileSync(file(data), JSON.stringify(f));
    expect(secretsStatus(data).state).toBe("undecryptable");
    expect(readSecrets(data).realDebridToken).toBe("");
    const r = ensureInstallSecrets(data);
    expect(r.recovered).toBeTruthy();
    expect(secretsStatus(data).state).toBe("ok");
    expect(readSecrets(data).sessionSecret.length).toBeGreaterThan(30);
    expect(readSecrets(data).realDebridToken).toBe("");
    const kept = fs.readdirSync(installPaths(data).secretsDir).filter((n) => n.startsWith("secrets.json.undecryptable-"));
    expect(kept).toHaveLength(1);
  });

  it.runIf(win)("detects a tampered ciphertext", () => {
    const data = fresh("enc-tamper");
    ensureInstallSecrets(data);
    const f = JSON.parse(fs.readFileSync(file(data), "utf8"));
    const bytes = Buffer.from(f.data, "base64");
    bytes[0] ^= 1;
    f.data = bytes.toString("base64");
    fs.writeFileSync(file(data), JSON.stringify(f));
    expect(secretsStatus(data).state).toBe("undecryptable");
  });
});

describe("first start", () => {
  it("creates folders and a one-time setup code, removed once an owner exists", () => {
    const data = path.join(scratch, "first-start");
    const r = initializeInstall(data);
    expect(r.created).toBe(true);
    expect(r.setupComplete).toBe(false);
    expect(r.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    for (const d of ["config", "secrets", "db", "logs", "run"]) expect(fs.existsSync(path.join(data, d))).toBe(true);
    // A second start keeps the same code.
    expect(initializeInstall(data).setupCode).toBe(r.setupCode);
    fs.writeFileSync(path.join(data, "db", "users.json"), JSON.stringify({ users: [{ id: "x", name: "o", role: "owner" }] }));
    expect(initializeInstall(data).setupCode).toBeNull();
    expect(readSetupCode(data)).toBeNull();
  });
});

describe("file lock", () => {
  it("serializes one-time operations and releases on errors", () => {
    const lock = path.join(scratch, "locks", "op.lock");
    expect(() => withFileLock(lock, () => withFileLock(lock, () => 1, { timeoutMs: 100 }))).toThrow(/Another request/);
    expect(fs.existsSync(lock)).toBe(false);
    expect(withFileLock(lock, () => 42)).toBe(42);
  });
});
