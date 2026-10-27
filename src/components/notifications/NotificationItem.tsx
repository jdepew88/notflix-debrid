"use client";

import { useRouter } from "next/navigation";
import { Bell, CalendarClock, Disc3, Film, Flame, MonitorPlay, Sparkles, Tv, X, AlertTriangle, Check } from "lucide-react";
import { posterUrl } from "@/lib/tmdb";
import { cn } from "@/lib/cn";
import { safeAppPath, titleFromLink } from "@/lib/notifications/links";
import { useDetailModal } from "@/providers/DetailModalProvider";
import type { NotificationView } from "@/lib/notifications/types";

const ICONS: Record<NotificationView["type"], typeof Bell> = {
  "new-episode": Tv,
  "new-episodes": Tv,
  "season-announced": CalendarClock,
  "season-released": Tv,
  "digital-release": Film,
  "physical-release": Disc3,
  "streaming-available": MonitorPlay,
  trending: Flame,
  recommendation: Sparkles,
  digest: Sparkles,
  service: AlertTriangle,
};

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
  for (const [unit, ms] of units) if (abs >= ms || unit === "minute") return rtf?.format(Math.round(diff / ms), unit) ?? "";
  return "";
}

/** Opens a notification's target: title links open the details dialog, others navigate. */
export function useOpenNotification() {
  const router = useRouter();
  const { openDetail } = useDetailModal();
  return (url: string, name?: string) => {
    const target = safeAppPath(url);
    const title = titleFromLink(target, name);
    if (title) openDetail(title);
    else router.push(target);
  };
}

export function NotificationItem({
  n,
  onOpen,
  onToggleRead,
  onDismiss,
  compact,
}: {
  n: NotificationView;
  onOpen: (n: NotificationView) => void;
  onToggleRead: (n: NotificationView) => void;
  onDismiss: (n: NotificationView) => void;
  compact?: boolean;
}) {
  const Icon = ICONS[n.type] ?? Bell;
  const image = posterUrl(n.image, "w185");
  const unread = !n.readAt;
  const openTitle = useOpenNotification();
  return (
    <li className={cn("group relative flex gap-3 px-4 py-3 transition", unread ? "bg-white/[0.06]" : "bg-transparent", "hover:bg-white/10")} data-testid="notification-item" data-unread={unread ? "true" : "false"}>
      <button
        type="button"
        onClick={() => onOpen(n)}
        className="flex min-w-0 flex-1 gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        data-notification-link
      >
        <span className={cn("relative shrink-0 overflow-hidden rounded bg-zinc-800", compact ? "h-[72px] w-12" : "h-24 w-16")}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- small TMDB poster thumbnail
            <img src={image} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-netflix-gray">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-netflix-gray">
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <time dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()}>
              {relativeTime(n.createdAt)}
            </time>
            {n.region && <span>· {n.region}</span>}
          </span>
          <span className={cn("mt-0.5 block text-sm leading-snug", unread ? "font-semibold text-white" : "text-netflix-light-gray")}>{n.title}</span>
          <span className={cn("mt-0.5 block text-[13px] leading-snug text-netflix-gray", compact && "line-clamp-2")}>{n.body}</span>
          {n.source === "justwatch-via-tmdb" && <span className="mt-0.5 block text-[11px] text-netflix-gray">Streaming data: JustWatch, via TMDB</span>}
          {unread && <span className="sr-only">(unread)</span>}
        </span>
      </button>
      {!compact && n.items?.length ? (
        <ul className="hidden max-w-[45%] flex-wrap gap-2 self-center sm:flex" aria-label="Titles in this notification">
          {n.items.map((item) => (
            <li key={`${item.mediaType}-${item.tmdbId}`}>
              <button
                type="button"
                onClick={() => openTitle(item.url, item.title)}
                title={item.reason ? `${item.title} · ${item.reason}` : item.title}
                className="block h-[72px] w-12 overflow-hidden rounded bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- small TMDB poster thumbnail
                  <img src={posterUrl(item.image, "w185")} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="block p-1 text-[10px]">{item.title}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="flex shrink-0 flex-col items-center gap-1">
        {unread && <span className="mt-1 h-2 w-2 rounded-full bg-netflix-red" aria-hidden />}
        <button
          type="button"
          onClick={() => onToggleRead(n)}
          aria-label={unread ? `Mark "${n.title}" as read` : `Mark "${n.title}" as unread`}
          title={unread ? "Mark as read" : "Mark as unread"}
          className="rounded p-1 text-netflix-gray opacity-100 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          data-testid="notification-toggle-read"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onDismiss(n)}
          aria-label={`Dismiss "${n.title}"`}
          title="Dismiss"
          className="rounded p-1 text-netflix-gray opacity-100 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          data-testid="notification-dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </span>
    </li>
  );
}
