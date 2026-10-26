import { afterEach, describe, expect, it } from "vitest";
import { cookieSecure, requestIsHttps, createSessionToken, parseSessionToken } from "./session";
import { signMediaPath, verifySignedMediaUrl } from "./signed-url";
import { normalizePlaybackSettings, toClientSettings, DEFAULT_PLAYBACK_SETTINGS, type ServerSettings } from "./server-settings";
import { debridHostCandidates } from "./real-debrid-api";

const req = (headers: Record<string, string>, protocol = "http:") => ({
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  nextUrl: { protocol },
});

describe("session cookies", () => {
  const original = process.env.COOKIE_SECURE;
  afterEach(() => {
    if (original === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = original;
  });

  it("are Secure only when the browser used HTTPS (auto)", () => {
    delete process.env.COOKIE_SECURE;
    expect(cookieSecure(req({}))).toBe(false); // plain HTTP on the LAN
    expect(cookieSecure(req({ "x-forwarded-proto": "https" }))).toBe(true); // HTTPS reverse proxy
    expect(cookieSecure(req({ "cf-visitor": '{"scheme":"https"}' }))).toBe(true); // Cloudflare-style proxy
    expect(cookieSecure(req({ "x-forwarded-proto": "http" }, "https:"))).toBe(false);
    expect(requestIsHttps(req({}, "https:"))).toBe(true);
  });

  it("honour an explicit COOKIE_SECURE", () => {
    process.env.COOKIE_SECURE = "false";
    expect(cookieSecure(req({ "x-forwarded-proto": "https" }))).toBe(false);
    process.env.COOKIE_SECURE = "true";
    expect(cookieSecure(req({}))).toBe(true);
  });

  it("tokens verify and reject tampering", async () => {
    const token = await createSessionToken("user-1", { version: 3 });
    expect(await parseSessionToken(token)).toEqual({ userId: "user-1", version: 3 });
    expect(await parseSessionToken(token.replace("user-1", "user-2"))).toBeNull();
    expect(await parseSessionToken(token.replace(".3.", ".4."))).toBeNull();
  });
});

describe("signed media URLs (Chromecast)", () => {
  it("verify for the same path and reject modified paths/params", async () => {
    const signed = await signMediaPath("/api/playback/abc/manifest?generation=2", 60, "u1");
    const url = new URL(signed, "http://x");
    expect(await verifySignedMediaUrl(url.pathname, url.searchParams)).toBe("u1");
    expect(await verifySignedMediaUrl("/api/playback/other/manifest", url.searchParams)).toBeNull();
    const tampered = new URLSearchParams(url.searchParams);
    tampered.set("generation", "3");
    expect(await verifySignedMediaUrl(url.pathname, tampered)).toBeNull();
  });
});

describe("settings", () => {
  it("validate untrusted playback settings and keep defaults for junk", () => {
    const n = normalizePlaybackSettings({
      maxResolution: 9999 as never,
      hardwareAcceleration: "rm -rf" as never,
      hardwareDevice: "../../etc; rm" as never,
      maxConcurrentTranscodes: 99,
      audioLanguage: "<script>",
    });
    expect(n.maxResolution).toBe(DEFAULT_PLAYBACK_SETTINGS.maxResolution);
    expect(n.hardwareAcceleration).toBe("auto");
    expect(n.hardwareDevice).toBeNull();
    expect(n.maxConcurrentTranscodes).toBe(8);
    expect(n.audioLanguage).toBe("en");
    for (const backend of ["nvenc", "qsv", "amf", "vaapi", "videotoolbox", "off"] as const) {
      expect(normalizePlaybackSettings({ hardwareAcceleration: backend }).hardwareAcceleration).toBe(backend);
    }
  });

  it("never include secrets in the client view", () => {
    const view = toClientSettings({
      ...DEFAULT_PLAYBACK_SETTINGS,
      realDebridToken: "RDTOKEN1234567890",
      tmdbApiKey: "TMDBKEY1234567890",
    } satisfies ServerSettings);
    const json = JSON.stringify(view);
    for (const secret of ["RDTOKEN1234567890", "TMDBKEY1234567890"]) expect(json).not.toContain(secret);
    expect(view.realDebridConfigured).toBe(true);
    expect(view.tmdbConfigured).toBe(true);
  });
});

describe("Real-Debrid host candidates", () => {
  it("try the dual-stack sibling of an IPv4-only (-4) host, then the region, then generic hosts", () => {
    const c = debridHostCandidates("lax5-4.download.real-debrid.com");
    expect(c[0]).toBe("lax5-4.download.real-debrid.com");
    expect(c[1]).toBe("lax5.download.real-debrid.com");
    expect(c).toContain("lax1.download.real-debrid.com");
    expect(c).toContain("100.download.real-debrid.com");
    expect(new Set(c).size).toBe(c.length);
  });
});
