/**
 * Native browser notifications: feature detection, permission and Web Push subscription.
 *
 * Three separate things decide whether a notification pops up on screen:
 *  1. the profile's preference ("Enable browser notifications", stored on the server);
 *  2. the browser's permission for this site (granted / denied / not asked), which only the user
 *     can change, in the browser's site settings. It is checked again whenever Notflix opens or
 *     regains focus; Notflix never asks again after "Block";
 *  3. the operating system (Windows notification settings, Focus / Do Not Disturb), which websites
 *     cannot see at all.
 * Browsers only offer notifications on secure origins: https:// or http://localhost. Notflix opened
 * as http://192.168.x.x shows in-app notifications only.
 */

export type BrowserNotifyState = "unsupported" | "insecure" | "default" | "granted" | "denied";

export interface BrowserEnv {
  isSecureContext: boolean;
  hasNotification: boolean;
  permission?: NotificationPermission;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hostname?: string;
}

export interface BrowserSupport {
  state: BrowserNotifyState;
  /** Background delivery (service worker + Web Push) is possible in this browser. */
  push: boolean;
  message: string;
}

export function browserSupport(env: BrowserEnv): BrowserSupport {
  if (!env.isSecureContext) {
    return {
      state: "insecure",
      push: false,
      message: `Browsers allow notifications only on secure addresses (https:// or http://localhost). ${env.hostname ? `This page was opened as http://${env.hostname}. ` : ""}Use Notflix through HTTPS (for example a reverse proxy) or on this computer as http://localhost to enable them. Notifications inside Notflix keep working.`,
    };
  }
  if (!env.hasNotification) {
    return { state: "unsupported", push: false, message: "This browser does not support notifications. Notifications inside Notflix keep working." };
  }
  const push = env.hasServiceWorker && env.hasPushManager;
  switch (env.permission) {
    case "granted":
      return { state: "granted", push, message: push ? "Allowed by this browser." : "Allowed by this browser (shown while Notflix is open; this browser has no background push)." };
    case "denied":
      return {
        state: "denied",
        push,
        message:
          "This browser blocks notifications from Notflix. To allow them again, open the site settings (the icon left of the address) and set Notifications to Allow, then reload. Notifications inside Notflix keep working.",
      };
    default:
      return { state: "default", push, message: "Your browser will ask for permission when you turn this on." };
  }
}

export function readBrowserEnv(): BrowserEnv {
  if (typeof window === "undefined") return { isSecureContext: false, hasNotification: false, hasServiceWorker: false, hasPushManager: false };
  const hasNotification = "Notification" in window;
  return {
    isSecureContext: window.isSecureContext,
    hasNotification,
    permission: hasNotification ? Notification.permission : undefined,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hostname: window.location.hostname,
  };
}

export const SERVICE_WORKER_URL = "/notflix-sw.js";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function json<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T };
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    const reg = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

/** Subscribes this browser to Web Push for the profile in use. Returns an error message or null. */
async function subscribePush(reg: ServiceWorkerRegistration): Promise<string | null> {
  try {
    const { ok, data } = await json<{ publicKey?: string; error?: string }>("/api/notifications/push");
    if (!ok || !data.publicKey) return data.error ?? "The server did not provide a push key.";
    const key = urlBase64ToUint8Array(data.publicKey);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another server key cannot be reused.
    if (sub && sub.options.applicationServerKey) {
      const current = new Uint8Array(sub.options.applicationServerKey);
      if (current.length !== key.length || current.some((b, i) => b !== key[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const saved = await json<{ error?: string }>("/api/notifications/push", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), label: browserLabel() }) });
    return saved.ok ? null : saved.data.error ?? "The server refused the subscription.";
  } catch (err) {
    return err instanceof Error ? err.message : "Push subscription failed.";
  }
}

export interface EnableResult {
  enabled: boolean;
  support: BrowserSupport;
  /** Background push active (otherwise notifications show while Notflix is open). */
  push: boolean;
  message: string;
}

/**
 * Must be called directly from a click: asks for permission only when the browser has not been
 * asked yet; never after "Block".
 */
export async function enableBrowserNotifications(): Promise<EnableResult> {
  let support = browserSupport(readBrowserEnv());
  if (support.state === "insecure" || support.state === "unsupported" || support.state === "denied") {
    return { enabled: false, support, push: false, message: support.message };
  }
  if (support.state === "default") {
    // First thing in the click handler, so the browser sees the user's gesture.
    const result = await Notification.requestPermission();
    support = browserSupport(readBrowserEnv());
    if (result !== "granted") {
      return {
        enabled: false,
        support,
        push: false,
        message: result === "denied" ? support.message : "You closed the browser's question without allowing notifications. Turn this on again to be asked once more.",
      };
    }
  }
  if (!support.push) return { enabled: true, support, push: false, message: support.message };
  const reg = await registerServiceWorker();
  if (!reg) return { enabled: true, support, push: false, message: "Allowed. The background service could not start, so notifications appear while Notflix is open." };
  const error = await subscribePush(reg);
  return error
    ? { enabled: true, support, push: false, message: `Allowed. Background push is unavailable (${error}), so notifications appear while Notflix is open.` }
    : { enabled: true, support, push: true, message: "Browser notifications are on, also while Notflix is closed." };
}

/** Removes this browser's push subscription (server and browser). */
export async function disableBrowserNotifications(): Promise<void> {
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await json("/api/notifications/push", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  } catch {
    /* nothing registered */
  }
}

/**
 * Re-checks the browser's permission (app opened, focus regained, settings viewed). Permission
 * withdrawn in the browser → this browser's subscription is removed and the state reports
 * "denied"/"default"; nothing is ever re-requested here. Still granted → makes sure this browser
 * is subscribed for the current profile (after a profile switch, for example).
 */
export async function syncBrowserNotifications(wanted: boolean): Promise<{ support: BrowserSupport; push: boolean }> {
  const support = browserSupport(readBrowserEnv());
  if (!wanted || support.state !== "granted") {
    if (support.state !== "insecure" && support.state !== "unsupported") await disableBrowserNotifications();
    return { support, push: false };
  }
  if (!support.push) return { support, push: false };
  try {
    const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await registerServiceWorker());
    if (!reg) return { support, push: false };
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const { data } = await json<{ thisBrowser?: boolean }>(`/api/notifications/push?endpoint=${encodeURIComponent(sub.endpoint)}`);
      if (data.thisBrowser) return { support, push: true };
    }
    return { support, push: (await subscribePush(reg)) === null };
  } catch {
    return { support, push: false };
  }
}
