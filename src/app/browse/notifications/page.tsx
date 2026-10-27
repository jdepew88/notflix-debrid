"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell, Loader2, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { useNotifications } from "@/components/notifications/NotificationsProvider";
import { NotificationItem, useOpenNotification } from "@/components/notifications/NotificationItem";
import { useNotificationList } from "@/components/notifications/useNotificationList";
import type { NotificationView } from "@/lib/notifications/types";

/** Every notification of the profile in use, newest first, with paging and filters. */
export default function NotificationsPage() {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { unread } = useNotifications();
  const { items, status, hasMore, loadingMore, loadMore, act, reload } = useNotificationList({ limit: 25, unreadOnly: filter === "unread" });
  const openTarget = useOpenNotification();

  const onOpen = (n: NotificationView) => {
    if (!n.readAt) void act("read", [n.id]);
    if (n.type === "digest") return;
    openTarget(n.url, n.name);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6 md:px-12" data-testid="notifications-page">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold md:text-3xl">
          <Bell className="h-6 w-6" aria-hidden /> Notifications
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <div role="group" aria-label="Show" className="flex rounded-full bg-white/10 p-0.5">
            {(["all", "unread"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn("rounded-full px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white", filter === f ? "bg-white text-black" : "text-netflix-light-gray hover:text-white")}
              >
                {f === "all" ? "All" : `Unread${unread ? ` (${unread})` : ""}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={unread === 0}
            onClick={() => void act("read-all")}
            className="rounded-md px-3 py-1.5 text-netflix-light-gray ring-1 ring-white/15 hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            Mark all as read
          </button>
          <Link href="/settings#notifications" className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-netflix-light-gray ring-1 ring-white/15 hover:bg-white/10 hover:text-white">
            <Settings className="h-4 w-4" aria-hidden /> Settings
          </Link>
        </div>
      </div>

      <section className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
        {status === "loading" || status === "idle" ? (
          <p className="flex items-center gap-2 px-4 py-10 text-sm text-netflix-gray" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading notifications…
          </p>
        ) : status === "error" && items.length === 0 ? (
          <div className="px-4 py-10 text-sm text-netflix-light-gray" role="alert">
            Notifications could not be loaded.{" "}
            <button type="button" onClick={() => void reload()} className="underline hover:text-white">
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-netflix-gray" data-testid="notifications-empty">
            {filter === "unread" ? "You're all caught up." : "No notifications yet. Add series and films to My List to hear about new episodes and releases."}
          </div>
        ) : (
          <ul className="divide-y divide-white/5" data-testid="notifications-list">
            {items.map((n) => (
              <NotificationItem
                key={n.id}
                n={n}
                onOpen={onOpen}
                onToggleRead={(x) => void act(x.readAt ? "unread" : "read", [x.id])}
                onDismiss={(x) => void act("dismiss", [x.id])}
              />
            ))}
          </ul>
        )}
      </section>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="flex items-center gap-2 rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/20 disabled:opacity-60"
            data-testid="notifications-more"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Show older notifications
          </button>
        </div>
      )}
      <p className="mt-6 text-xs leading-relaxed text-netflix-gray">
        Release dates, episode information and trending titles come from TMDB; streaming availability from JustWatch via TMDB. A release
        notification means the title is out, not that a copy is available to play here.
      </p>
    </div>
  );
}
