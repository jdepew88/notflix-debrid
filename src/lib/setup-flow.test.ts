/**
 * First-run setup through the real route handlers (fresh data directory, no network): setup code,
 * owner creation, refusal after initialization, owner-only configuration, sign-up policy.
 * Provider validation is exercised with fetch stubbed (simulated TMDB / Real-Debrid answers).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-setup-"));
process.env.NOTFLIX_DATA_DIR = dataDir;

// next/headers' cookies() needs a request context; give route handlers the cookies of the
// request currently being handled.
let currentCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (currentCookies.has(name) ? { name, value: currentCookies.get(name)! } : undefined) }),
}));

type Jar = Map<string, string>;
function request(url: string, init: { method?: string; body?: unknown; jar?: Jar } = {}) {
  const jar = init.jar ?? new Map();
  currentCookies = jar;
  const headers = new Headers({ "content-type": "application/json", "x-notflix-peer": "127.0.0.1" });
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  return new NextRequest(new URL(url, "http://localhost:8420"), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
function keepCookies(res: Response, jar: Jar) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, ...v] = pair.split("=");
    const value = v.join("=");
    if (/max-age=0/i.test(c) || value === "") jar.delete(k.trim());
    else jar.set(k.trim(), value);
  }
}

let routes: {
  status: typeof import("@/app/api/setup/status/route");
  unlock: typeof import("@/app/api/setup/unlock/route");
  owner: typeof import("@/app/api/setup/owner/route");
  complete: typeof import("@/app/api/setup/complete/route");
  server: typeof import("@/app/api/config/server/route");
  metadata: typeof import("@/app/api/config/metadata/route");
  debrid: typeof import("@/app/api/config/debrid/route");
  signup: typeof import("@/app/api/auth/signup/route");
  login: typeof import("@/app/api/auth/login/route");
};
let setupCode = "";

beforeAll(async () => {
  const { initializeInstall } = await import("./install/init.mjs");
  setupCode = initializeInstall(dataDir).setupCode!;
  routes = {
    status: await import("@/app/api/setup/status/route"),
    unlock: await import("@/app/api/setup/unlock/route"),
    owner: await import("@/app/api/setup/owner/route"),
    complete: await import("@/app/api/setup/complete/route"),
    server: await import("@/app/api/config/server/route"),
    metadata: await import("@/app/api/config/metadata/route"),
    debrid: await import("@/app/api/config/debrid/route"),
    signup: await import("@/app/api/auth/signup/route"),
    login: await import("@/app/api/auth/login/route"),
  };
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const owner: Jar = new Map();

describe("fresh installation", () => {
  it("starts with no accounts, setup incomplete and a setup code on disk", async () => {
    expect(fs.existsSync(path.join(dataDir, "db", "users.json"))).toBe(false);
    const res = await routes.status.GET(request("/api/setup/status"));
    const body = await res.json();
    expect(body).toMatchObject({ setupComplete: false, ownerExists: false, unlocked: false });
    expect(setupCode).toMatch(/^[A-Z2-9]{4}-/);
  });

  it("rejects configuration and owner creation without the setup code", async () => {
    expect((await routes.server.GET(request("/api/config/server"))).status).toBe(401);
    const res = await routes.owner.POST(request("/api/setup/owner", { method: "POST", body: { name: "mallory", password: "password-1", confirm: "password-1" } }));
    expect(res.status).toBe(401);
    const wrong = await routes.unlock.POST(request("/api/setup/unlock", { method: "POST", body: { code: "AAAA-BBBB-CCCC" } }));
    expect(wrong.status).toBe(401);
  });

  it("unlocks with the code and saves server settings", async () => {
    const res = await routes.unlock.POST(request("/api/setup/unlock", { method: "POST", body: { code: setupCode.toLowerCase() }, jar: owner }));
    expect(res.status).toBe(200);
    keepCookies(res, owner);
    expect(owner.has("notflix_setup")).toBe(true);
    const bad = await routes.server.PUT(request("/api/config/server", { method: "PUT", body: { port: 80, cacheDirectory: dataDir }, jar: owner }));
    expect(bad.status).toBe(400);
    const errors = (await bad.json()).errors;
    expect(errors.port).toBeTruthy();
    expect(errors.cacheDirectory).toBeTruthy();
    const ok = await routes.server.PUT(request("/api/config/server", { method: "PUT", body: { port: 8430, cacheMaxGiB: 20, hostname: "media-pc.local" }, jar: owner }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).server.port).toBe(8430);
  });

  it("creates exactly one owner and signs them in", async () => {
    const mismatch = await routes.owner.POST(request("/api/setup/owner", { method: "POST", body: { name: "owner", password: "password-1", confirm: "password-2" }, jar: owner }));
    expect(mismatch.status).toBe(400);
    const res = await routes.owner.POST(request("/api/setup/owner", { method: "POST", body: { name: "owner", displayName: "House Owner", password: "password-1", confirm: "password-1" }, jar: owner }));
    expect(res.status).toBe(200);
    keepCookies(res, owner);
    expect((await res.json()).user.role).toBe("owner");
    expect(owner.has("notflix_session")).toBe(true);
    expect(owner.has("notflix_setup")).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "setup-code.txt"))).toBe(false);
    // The same (now invalid) setup cookie or a second attempt cannot create another owner.
    const again = await routes.owner.POST(request("/api/setup/owner", { method: "POST", body: { name: "owner2", password: "password-1", confirm: "password-1" }, jar: new Map([["notflix_setup", "setup.9999999999999.x.y"]]) }));
    expect(again.status).toBe(409);
    const unlockAgain = await routes.unlock.POST(request("/api/setup/unlock", { method: "POST", body: { code: setupCode } }));
    expect(unlockAgain.status).toBe(409);
  });

  it("validates provider credentials before storing them (simulated TMDB / Real-Debrid)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("themoviedb.org")) {
        return url.includes("api_key=GOODKEY") ? new Response("{}", { status: 200 }) : new Response('{"status_code":7}', { status: 401 });
      }
      if (url.includes("real-debrid.com/rest/1.0/user")) {
        return new Response(JSON.stringify({ id: 1, username: "rd-user", email: "x", premium: 1, expiration: new Date(Date.now() + 864e6).toISOString() }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const badKey = await routes.metadata.PUT(request("/api/config/metadata", { method: "PUT", body: { tmdbApiKey: "BADKEY-0123456789abcdef" }, jar: owner }));
    expect(badKey.status).toBe(400);
    const { readSecrets } = await import("./install/secrets.mjs");
    expect(readSecrets(dataDir).tmdbApiKey).toBe("");
    const goodKey = await routes.metadata.PUT(request("/api/config/metadata", { method: "PUT", body: { tmdbApiKey: "GOODKEY0123456789abcdef" }, jar: owner }));
    expect(goodKey.status).toBe(200);
    const view = await goodKey.json();
    expect(JSON.stringify(view)).not.toContain("GOODKEY0123456789abcdef");
    expect(view.tmdb.configured).toBe(true);

    const malformed = await routes.debrid.PUT(request("/api/config/debrid", { method: "PUT", body: { token: "not a token!" }, jar: owner }));
    expect(malformed.status).toBe(400);
    const rd = await routes.debrid.PUT(request("/api/config/debrid", { method: "PUT", body: { token: "RDTOKENABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", sources: { torrentio: true } }, jar: owner }));
    expect(rd.status).toBe(200);
    const rdView = await rd.json();
    expect(JSON.stringify(rdView)).not.toContain("RDTOKENABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(rdView.account).toBe("rd-user");
    vi.unstubAllGlobals();
  });

  it("refuses to complete while the media engine is unreachable", async () => {
    process.env.MEDIA_ENGINE_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
    const res = await routes.complete.POST(request("/api/setup/complete", { method: "POST", body: {}, jar: owner }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.missing.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(["engine"]));
    delete process.env.MEDIA_ENGINE_URL;
  });

  it("keeps configuration owner-only and sign-up closed by default", async () => {
    const { createUser } = await import("./users");
    await createUser("member", "password-2");
    const member: Jar = new Map();
    const login = await routes.login.POST(request("/api/auth/login", { method: "POST", body: { name: "member", password: "password-2" }, jar: member }));
    expect(login.status).toBe(200);
    keepCookies(login, member);
    expect((await routes.server.GET(request("/api/config/server", { jar: member }))).status).toBe(403);
    expect((await routes.debrid.GET(request("/api/config/debrid", { jar: member }))).status).toBe(403);
    // Sign-up is unavailable while setup is incomplete, and closed by default afterwards.
    expect((await routes.signup.POST(request("/api/auth/signup", { method: "POST", body: { name: "stranger", password: "password-3" } }))).status).toBe(403);
    const { updateServerConfig } = await import("./install/config.mjs");
    updateServerConfig(dataDir, (c) => {
      c.setup.completed = true;
    });
    const closed = await routes.signup.POST(request("/api/auth/signup", { method: "POST", body: { name: "stranger", password: "password-3" } }));
    expect(closed.status).toBe(403);
    expect((await closed.json()).code).toBe("signup_closed");
  });

  it("cannot be restarted after initialization", async () => {
    expect((await routes.unlock.POST(request("/api/setup/unlock", { method: "POST", body: { code: setupCode } }))).status).toBe(409);
    expect((await routes.complete.POST(request("/api/setup/complete", { method: "POST", body: {}, jar: owner }))).status).toBe(409);
    const status = await (await routes.status.GET(request("/api/setup/status"))).json();
    expect(status.setupComplete).toBe(true);
  });

  it("survives a restart: configuration and accounts are read back from disk", async () => {
    const { readServerConfig } = await import("./install/config.mjs");
    const cfg = readServerConfig(dataDir);
    expect(cfg.server.port).toBe(8430);
    expect(cfg.server.hostname).toBe("media-pc.local");
    expect(cfg.storage.cacheMaxGiB).toBe(20);
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, "db", "users.json"), "utf8")).users;
    expect(users.map((u: { name: string; role: string }) => [u.name, u.role])).toEqual([
      ["owner", "owner"],
      ["member", "user"],
    ]);
  });
});
