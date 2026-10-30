/**
 * Browser notification handling with simulated browsers: support detection (secure contexts,
 * unsupported browsers), permission granted / denied / not asked, revocation after enabling,
 * subscription registration and removal, and the service worker's push and click handling.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserSupport, disableBrowserNotifications, enableBrowserNotifications, syncBrowserNotifications } from "./browser";
import { safeAppPath, titleFromLink } from "./links";

const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");

interface FakeBrowser {
  permission: NotificationPermission;
  answer: NotificationPermission;
  requests: number;
  subscription: { endpoint: string; options: { applicationServerKey: ArrayBuffer }; toJSON(): unknown; unsubscribe(): Promise<boolean> } | null;
  registered: string[];
  server: Array<{ method: string; url: string; body?: unknown }>;
  thisBrowser: boolean;
}

/** Installs a fake window/Notification/serviceWorker/PushManager/fetch. */
function installBrowser(opts: { secure?: boolean; notification?: boolean; push?: boolean; permission?: NotificationPermission; answer?: NotificationPermission } = {}): FakeBrowser {
  const b: FakeBrowser = { permission: opts.permission ?? "default", answer: opts.answer ?? "granted", requests: 0, subscription: null, registered: [], server: [], thisBrowser: false };
  const makeSub = () => ({
    endpoint: "https://fcm.googleapis.com/fcm/send/fake",
    options: { applicationServerKey: new Uint8Array(Buffer.from(KEY, "base64url")).buffer },
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/fake", keys: { p256dh: KEY, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }),
    unsubscribe: async () => {
      b.subscription = null;
      return true;
    },
  });
  const pushManager = {
    getSubscription: async () => b.subscription,
    subscribe: async () => (b.subscription = makeSub()),
  };
  const registration = { pushManager };
  const NotificationStub = function Notification() {} as unknown as { permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission> };
  Object.defineProperty(NotificationStub, "permission", { get: () => b.permission });
  NotificationStub.requestPermission = async () => {
    b.requests++;
    b.permission = b.answer;
    return b.answer;
  };
  const win: Record<string, unknown> = { isSecureContext: opts.secure ?? true, location: { hostname: opts.secure === false ? "192.168.1.20" : "localhost" } };
  if (opts.notification !== false) win.Notification = NotificationStub;
  if (opts.push !== false) win.PushManager = function PushManager() {};
  vi.stubGlobal("window", win);
  if (opts.notification !== false) vi.stubGlobal("Notification", NotificationStub);
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130",
    ...(opts.push !== false
      ? {
          serviceWorker: {
            register: async (url: string) => {
              b.registered.push(url);
              return registration;
            },
            ready: Promise.resolve(registration),
            getRegistration: async () => (b.registered.length ? registration : undefined),
          },
        }
      : {}),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    b.server.push({ method: init?.method ?? "GET", url, body });
    if (url.startsWith("/api/notifications/push?endpoint=")) return new Response(JSON.stringify({ thisBrowser: b.thisBrowser }));
    if (url === "/api/notifications/push" && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ publicKey: KEY }));
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal("atob", (s: string) => Buffer.from(s, "base64").toString("binary"));
  return b;
}

afterEach(() => vi.unstubAllGlobals());

describe("support detection", () => {
  it("explains each state", () => {
    const base = { isSecureContext: true, hasNotification: true, hasServiceWorker: true, hasPushManager: true };
    expect(browserSupport({ ...base, permission: "granted" })).toMatchObject({ state: "granted", push: true });
    expect(browserSupport({ ...base, permission: "default" })).toMatchObject({ state: "default" });
    expect(browserSupport({ ...base, permission: "denied" }).message).toMatch(/site settings/);
    expect(browserSupport({ ...base, hasNotification: false })).toMatchObject({ state: "unsupported", push: false });
    expect(browserSupport({ ...base, hasPushManager: false, permission: "granted" })).toMatchObject({ state: "granted", push: false });
  });

  it("does not offer notifications over plain HTTP on a LAN address", () => {
    const s = browserSupport({ isSecureContext: false, hasNotification: true, hasServiceWorker: false, hasPushManager: false, permission: "default", hostname: "192.168.1.20" });
    expect(s.state).toBe("insecure");
    expect(s.message).toContain("http://192.168.1.20");
    expect(s.message).toMatch(/https:\/\/ or http:\/\/localhost/);
  });
});

describe("enabling and disabling", () => {
  it("asks once when not asked yet, registers the service worker and subscribes", async () => {
    const b = installBrowser({ permission: "default", answer: "granted" });
    const r = await enableBrowserNotifications();
    expect(r).toMatchObject({ enabled: true, push: true });
    expect(b.requests).toBe(1);
    expect(b.registered).toEqual(["/notflix-sw.js"]);
    const post = b.server.find((s) => s.method === "POST");
    expect(post).toMatchObject({ url: "/api/notifications/push", body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/fake" }, label: "Chrome on Windows" } });
  });

  it("never prompts again after the user blocked notifications", async () => {
    const b = installBrowser({ permission: "denied" });
    const r = await enableBrowserNotifications();
    expect(r.enabled).toBe(false);
    expect(b.requests).toBe(0);
    expect(r.message).toMatch(/blocks notifications/);
    expect(b.registered).toEqual([]);
  });

  it("stays off when the user answers Block or closes the prompt", async () => {
    const blocked = installBrowser({ permission: "default", answer: "denied" });
    expect((await enableBrowserNotifications()).enabled).toBe(false);
    expect(blocked.server.filter((s) => s.method === "POST")).toEqual([]);
    vi.unstubAllGlobals();
    installBrowser({ permission: "default", answer: "default" });
    expect((await enableBrowserNotifications()).message).toMatch(/closed the browser's question/);
  });

  it("does nothing in unsupported browsers and on insecure origins", async () => {
    const none = installBrowser({ notification: false, push: false });
    expect(await enableBrowserNotifications()).toMatchObject({ enabled: false, support: { state: "unsupported" } });
    expect(none.requests).toBe(0);
    vi.unstubAllGlobals();
    const lan = installBrowser({ secure: false });
    expect(await enableBrowserNotifications()).toMatchObject({ enabled: false, support: { state: "insecure" } });
    expect(lan.requests).toBe(0);
  });

  it("falls back to notifications while open when the browser has no push support", async () => {
    installBrowser({ permission: "granted", push: false });
    expect(await enableBrowserNotifications()).toMatchObject({ enabled: true, push: false });
  });

  it("notices permission withdrawn in the browser and removes this browser's subscription", async () => {
    const b = installBrowser({ permission: "default", answer: "granted" });
    await enableBrowserNotifications();
    b.thisBrowser = true;
    expect(await syncBrowserNotifications(true)).toMatchObject({ support: { state: "granted" }, push: true });
    // The user resets the site permission in Chrome / Edge / Firefox settings.
    b.permission = "denied";
    const r = await syncBrowserNotifications(true);
    expect(r).toMatchObject({ support: { state: "denied" }, push: false });
    expect(b.subscription).toBeNull();
    expect(b.server.at(-1)).toMatchObject({ method: "DELETE", body: { endpoint: "https://fcm.googleapis.com/fcm/send/fake" } });
    expect(b.requests).toBe(1); // never re-asked
  });

  it("re-registers the subscription for the current profile after a switch", async () => {
    const b = installBrowser({ permission: "granted" });
    await enableBrowserNotifications();
    const posts = () => b.server.filter((s) => s.method === "POST").length;
    expect(posts()).toBe(1);
    b.thisBrowser = false; // the new profile has no subscription for this browser yet
    expect((await syncBrowserNotifications(true)).push).toBe(true);
    expect(posts()).toBe(2);
  });

  it("disabling removes the subscription from the server and the browser", async () => {
    const b = installBrowser({ permission: "granted" });
    await enableBrowserNotifications();
    await disableBrowserNotifications();
    expect(b.subscription).toBeNull();
    expect(b.server.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("links and the service worker", () => {
  it("opens titles from notification links and refuses foreign targets", () => {
    expect(titleFromLink("/browse?title=tmdb-tv-1399&season=3", "Game of Thrones")).toMatchObject({ id: "tmdb-tv-1399", tmdbId: 1399, mediaType: "tv", type: "series", season: 3, title: "Game of Thrones" });
    expect(titleFromLink("/browse?title=tmdb-603")).toMatchObject({ id: "tmdb-603", mediaType: "movie", type: "movie" });
    expect(titleFromLink("/settings#notifications")).toBeNull();
    expect(titleFromLink("/browse?title=javascript:alert(1)")).toBeNull();
    expect(safeAppPath("//evil.example/x")).toBe("/browse");
    expect(safeAppPath("https://evil.example")).toBe("/browse");
    expect(safeAppPath("/\\evil.example")).toBe("/browse");
    expect(safeAppPath("/settings#notifications")).toBe("/settings#notifications");
  });

  function loadServiceWorker(clients: Array<{ url: string; focus: () => Promise<unknown>; navigate?: (u: string) => Promise<unknown>; postMessage: (m: unknown) => void }>) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
    const opened: string[] = [];
    const self = {
      location: { origin: "http://localhost:8420" },
      addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
      skipWaiting: () => {},
      registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
      clients: { claim: async () => {}, matchAll: async () => clients, openWindow: async (u: string) => void opened.push(u) },
    };
    vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "public", "notflix-sw.js"), "utf8"), { self, URL, Promise });
    const run = async (type: string, event: Record<string, unknown>) => {
      let wait: Promise<unknown> = Promise.resolve();
      listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
      await wait;
    };
    return { listeners, shown, opened, run };
  }

  it("shows pushed notifications and tells open pages to refresh", async () => {
    const messages: unknown[] = [];
    const sw = loadServiceWorker([{ url: "http://localhost:8420/browse", focus: async () => null, postMessage: (m) => messages.push(m) }]);
    expect(Object.keys(sw.listeners)).not.toContain("fetch"); // never intercepts pages or video
    await sw.run("push", { data: { json: () => ({ title: "Show: new episode", body: "S1 E2 is out.", url: "/browse?title=tmdb-tv-1", tag: "abc", icon: "https://evil.example/x.png" }) } });
    expect(sw.shown[0]).toMatchObject({ title: "Show: new episode", options: { body: "S1 E2 is out.", tag: "abc", icon: "/icon.svg", data: { url: "/browse?title=tmdb-tv-1" } } });
    expect(messages).toEqual([{ type: "notflix:notifications-changed" }]);
    await sw.run("push", { data: { json: () => ({ title: "x", url: "https://evil.example/phish" }) } });
    expect(sw.shown[1].options.data).toEqual({ url: "/browse" });
  });

  it("opens the notification's page on click: an open Notflix tab, else a new window", async () => {
    const navigated: string[] = [];
    const tab = { url: "http://localhost:8420/browse", focus: async () => tab, navigate: async (u: string) => void navigated.push(u), postMessage: () => {} };
    const sw = loadServiceWorker([tab]);
    await sw.run("notificationclick", { notification: { close: () => {}, data: { url: "/browse?title=tmdb-603" } } });
    expect(navigated).toEqual(["http://localhost:8420/browse?title=tmdb-603"]);
    const none = loadServiceWorker([]);
    await none.run("notificationclick", { notification: { close: () => {}, data: { url: "//evil.example" } } });
    expect(none.opened).toEqual(["http://localhost:8420/browse"]);
  });
});
