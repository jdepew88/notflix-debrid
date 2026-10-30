"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useNotifications } from "./NotificationsProvider";
import { NotificationItem, useOpenNotification } from "./NotificationItem";
import { useNotificationList } from "./useNotificationList";
import type { NotificationView } from "@/lib/notifications/types";

/** The navigation bar's bell: unread badge and a popover with the newest notifications. */
export function NotificationBell() {
  const { unread } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { items, status, act, reload } = useNotificationList({ limit: 8, enabled: open });
  const openTarget = useOpenNotification();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      // Arrow keys move between notifications (TV remotes and keyboards).
      const links = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-notification-link]") ?? [])];
      if (!links.length) return;
      e.preventDefault();
      const at = links.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? Math.min(links.length - 1, at + 1) : Math.max(0, at - 1);
      links[at === -1 ? 0 : next].focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && status === "ready") panelRef.current?.querySelector<HTMLElement>("[data-notification-link]")?.focus();
  }, [open, status]);

  const onOpen = (n: NotificationView) => {
    if (!n.readAt) void act("read", [n.id]);
    setOpen(false);
    openTarget(n.url, n.name);
  };

  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        data-testid="notification-bell"
        className="relative flex items-center rounded text-white hover:text-netflix-light-gray focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span
            className="absolute -right-2 -top-1.5 min-w-[18px] rounded-full bg-netflix-red px-1 text-center text-[11px] font-bold leading-[18px] text-white"
            data-testid="notification-badge"
            aria-hidden
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          data-testid="notification-panel"
          className="fixed inset-x-2 top-16 z-[60] max-h-[75vh] overflow-hidden rounded-md border border-white/10 bg-black/95 shadow-2xl backdrop-blur sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-3 sm:w-[400px]"
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <button
              type="button"
              disabled={unread === 0}
              onClick={() => void act("read-all")}
              className="rounded px-2 py-1 text-xs text-netflix-light-gray hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
              data-testid="notifications-read-all"
            >
              Mark all as read
            </button>
          </div>
          <div className="max-h-[calc(75vh-96px)] overflow-y-auto">
            {status === "loading" || status === "idle" ? (
              <p className="flex items-center gap-2 px-4 py-8 text-sm text-netflix-gray" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading notifications…
              </p>
            ) : status === "error" ? (
              <div className="px-4 py-6 text-sm text-netflix-light-gray" role="alert">
                Notifications could not be loaded.{" "}
                <button type="button" onClick={() => void reload()} className="underline hover:text-white">
                  Try again
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-netflix-gray" data-testid="notifications-empty">
                <Bell className="mx-auto mb-2 h-6 w-6" aria-hidden />
                No notifications yet. Add series to My List to hear about new episodes.
              </div>
            ) : (
              <ul className={cn("divide-y divide-white/5")}>
                {items.map((n) => (
                  <NotificationItem
                    key={n.id}
                    n={n}
                    compact
                    onOpen={onOpen}
                    onToggleRead={(x) => void act(x.readAt ? "unread" : "read", [x.id])}
                    onDismiss={(x) => void act("dismiss", [x.id])}
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-white/10 px-4 py-2.5 text-xs">
            <Link href="/browse/notifications" onClick={() => setOpen(false)} className="font-semibold text-white hover:underline" data-testid="notifications-view-all">
              View all notifications
            </Link>
            <Link href="/settings#notifications" onClick={() => setOpen(false)} className="text-netflix-gray hover:text-white hover:underline">
              Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
