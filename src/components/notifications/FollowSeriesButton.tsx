"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Follow a series for new-episode and new-season notifications (per profile). Series in My List or
 * Continue Watching are followed automatically; this button can also turn that off.
 */
export function FollowSeriesButton({ tmdbId, title, inList }: { tmdbId: number; title: string; inList: boolean }) {
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/notifications/follow?tmdbId=${tmdbId}`, { credentials: "include", signal: controller.signal, cache: "no-store" })
      .then(async (r) => (r.ok ? setFollowing(((await r.json()) as { following: boolean }).following) : setFollowing(null)))
      .catch(() => undefined);
    return () => controller.abort();
    // My List changes follow the series automatically: ask again.
  }, [tmdbId, inList]);

  if (following === null) return null;
  const toggle = async () => {
    setBusy(true);
    const next = !following;
    setFollowing(next);
    const res = await fetch("/api/notifications/follow", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId, follow: next, title }),
    }).catch(() => null);
    if (!res?.ok) setFollowing(!next);
    setBusy(false);
  };
  const label = following ? "Stop notifications for new episodes" : "Notify me about new episodes";
  const Icon = following ? BellRing : busy ? BellOff : Bell;
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={following}
      aria-label={label}
      title={label}
      data-testid="details-follow"
      className={cn(
        "flex h-11 w-11 items-center justify-center rounded-full border-2 bg-black/40 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
        following ? "border-white text-white" : "border-white/60 hover:border-white"
      )}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
