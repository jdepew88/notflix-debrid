"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationAction } from "@/lib/notifications/store";
import type { NotificationPage, NotificationView } from "@/lib/notifications/types";
import { useNotifications } from "./NotificationsProvider";

type Status = "idle" | "loading" | "ready" | "error";

/** Loads a profile's notifications page by page and applies read/dismiss actions. */
export function useNotificationList(opts: { limit: number; unreadOnly?: boolean; enabled?: boolean }) {
  const { version, setUnread } = useNotifications();
  const [items, setItems] = useState<NotificationView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const enabled = opts.enabled ?? true;
  const req = useRef(0);
  /** Bumped by every read/dismiss: list responses requested before it are stale and dropped. */
  const mutation = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const id = ++req.current;
      const qs = new URLSearchParams({ limit: String(opts.limit) });
      if (after) qs.set("cursor", after);
      if (opts.unreadOnly) qs.set("unread", "1");
      const res = await fetch(`/api/notifications?${qs}`, { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as NotificationPage;
      if (id !== req.current && !after) return null;
      return page;
    },
    [opts.limit, opts.unreadOnly]
  );

  const reload = useCallback(async () => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    const started = mutation.current;
    try {
      const page = await load(null);
      if (!page || started !== mutation.current) return;
      setUnread(page.unread);
      setItems(page.items);
      setCursor(page.nextCursor);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [load, setUnread]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when opened / notifications change
    if (enabled) void reload();
  }, [enabled, version, reload]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await load(cursor);
      if (page) {
        setUnread(page.unread);
        setItems((list) => [...list, ...page.items.filter((n) => !list.some((x) => x.id === n.id))]);
        setCursor(page.nextCursor);
      }
    } catch {
      setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, load, setUnread]);

  const act = useCallback(
    async (action: NotificationAction, ids: string[] = []) => {
      // Optimistic; the server's unread count corrects it.
      mutation.current++;
      const stamp = new Date().toISOString();
      setItems((list) =>
        action === "dismiss"
          ? list.filter((n) => !ids.includes(n.id))
          : list.map((n) =>
              action === "read-all" || ids.includes(n.id)
                ? action === "unread"
                  ? { ...n, readAt: undefined }
                  : { ...n, readAt: n.readAt ?? stamp }
                : n
            )
      );
      try {
        const res = await fetch("/api/notifications", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ids }),
        });
        if (res.ok) setUnread(((await res.json()) as { unread: number }).unread);
        else void reload();
      } catch {
        void reload();
      }
    },
    [reload, setUnread]
  );

  return { items, status, hasMore: Boolean(cursor), loadingMore, loadMore, reload, act };
}
