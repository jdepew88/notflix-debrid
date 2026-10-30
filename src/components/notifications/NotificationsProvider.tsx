"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAppStore, useNotificationPreferences } from "@/lib/store";
import { browserSupport, readBrowserEnv, syncBrowserNotifications, type BrowserSupport } from "@/lib/notifications/browser";
import { regionFromLocale, validTimeZone } from "@/lib/notifications/preferences";
import type { NotificationPage, NotificationView } from "@/lib/notifications/types";

/** How often the unread count is refreshed while a page is visible and Web Push is not active. */
const POLL_MS = 5 * 60_000;
const SHOWN_KEY = "notflix:notified-until";

interface NotificationsContextValue {
  unread: number;
  /** Bumped whenever notifications may have changed (lists reload on change). */
  version: number;
  refresh: () => void;
  setUnread: (n: number) => void;
  /** Browser permission / support as last checked. */
  browser: BrowserSupport | null;
  /** Web Push is registered for this browser and profile. */
  pushActive: boolean;
  recheckBrowser: () => Promise<void>;
}

const Ctx = createContext<NotificationsContextValue | null>(null);

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}

/** Foreground notification (no service worker push): only for new items, at most three at once. */
function showForeground(items: NotificationView[]) {
  let since = 0;
  try {
    since = Number(sessionStorage.getItem(SHOWN_KEY)) || 0;
  } catch {
    /* storage unavailable */
  }
  const fresh = since ? items.filter((n) => !n.readAt && Date.parse(n.createdAt) > since).slice(0, 3) : [];
  const newest = Math.max(since || Date.now(), ...items.map((n) => Date.parse(n.createdAt)));
  try {
    sessionStorage.setItem(SHOWN_KEY, String(newest));
  } catch {
    /* ignore */
  }
  // The first check after opening Notflix only records what exists; it never replays old items.
  for (const n of fresh) {
    try {
      const note = new Notification(n.title, { body: n.body, tag: n.id, icon: n.image ? `https://image.tmdb.org/t/p/w185${n.image}` : "/icon.svg" });
      note.onclick = () => {
        window.focus();
        if (n.url.startsWith("/") && !n.url.startsWith("//")) window.location.assign(n.url);
      };
    } catch {
      /* permission withdrawn meanwhile */
    }
  }
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const user = useAppStore((s) => s.user);
  const profileId = useAppStore((s) => s.activeProfileId);
  const notifyPrefs = useNotificationPreferences();
  const wantsBrowser = notifyPrefs.browser;
  const ready = useAppStore((s) => s.userStateReady);
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);
  const [browser, setBrowser] = useState<BrowserSupport | null>(null);
  const [pushActive, setPushActive] = useState(false);
  const active = Boolean(user && profileId);
  const onPlayer = pathname?.startsWith("/watch") ?? false;
  const latest = useRef({ wantsBrowser, pushActive, onPlayer });
  useEffect(() => {
    latest.current = { wantsBrowser, pushActive, onPlayer };
  }, [wantsBrowser, pushActive, onPlayer]);

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const res = await fetch("/api/notifications?limit=10", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const page = (await res.json()) as NotificationPage;
      setUnread(page.unread);
      setVersion((v) => v + 1);
      const l = latest.current;
      // Background push shows its own notifications; while Notflix is open without push, show new ones here.
      if (l.wantsBrowser && !l.pushActive && !l.onPlayer && typeof Notification !== "undefined" && Notification.permission === "granted") showForeground(page.items);
    } catch {
      /* offline: keep the last count */
    }
  }, [active]);

  // Region and time zone default to this browser's (once per profile, after its preferences loaded).
  useEffect(() => {
    if (!active || !ready) return;
    const patch: { region?: string; timeZone?: string } = {};
    if (!notifyPrefs.region) {
      const region = regionFromLocale(navigator.language);
      if (region) patch.region = region;
    }
    if (!notifyPrefs.timeZone) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (validTimeZone(tz)) patch.timeZone = tz;
    }
    if (Object.keys(patch).length) updatePreferences({ notifications: { ...notifyPrefs, ...patch } });
    // Only when the profile or its loaded preferences change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ready, profileId, notifyPrefs.region, notifyPrefs.timeZone]);

  const recheckBrowser = useCallback(async () => {
    if (!active) return;
    const r = await syncBrowserNotifications(latest.current.wantsBrowser);
    setBrowser(r.support);
    setPushActive(r.push);
  }, [active]);

  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- signed out / no profile: nothing to show
      setUnread(0);
      return;
    }
    void refresh();
    void recheckBrowser();
  }, [active, profileId, wantsBrowser, refresh, recheckBrowser]);

  // Permission may change in the browser's settings at any time: check again on focus.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      setBrowser(browserSupport(readBrowserEnv()));
      void recheckBrowser();
      void refresh();
    };
    const onVisible = () => document.visibilityState === "visible" && onFocus();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refresh, recheckBrowser]);

  // Pushes reach the page through the service worker; without push, poll gently while visible.
  useEffect(() => {
    if (!active) return;
    const onMessage = (e: MessageEvent) => e.data?.type === "notflix:notifications-changed" && void refresh();
    navigator.serviceWorker?.addEventListener("message", onMessage);
    const timer = pushActive
      ? null
      : window.setInterval(() => {
          if (document.visibilityState === "visible") void refresh();
        }, POLL_MS);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      if (timer) window.clearInterval(timer);
    };
  }, [active, pushActive, refresh]);

  const value = useMemo(
    () => ({ unread, version, refresh: () => void refresh(), setUnread, browser, pushActive, recheckBrowser }),
    [unread, version, refresh, browser, pushActive, recheckBrowser]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
