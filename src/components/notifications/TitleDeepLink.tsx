"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useDetailModal } from "@/providers/DetailModalProvider";
import { titleFromLink } from "@/lib/notifications/links";

/**
 * Opens the details of a title linked as /browse?title=tmdb-123 (or tmdb-tv-123&season=2), the
 * address notifications and browser pushes use, then removes the parameters from the address bar.
 */
export function TitleDeepLink() {
  const params = useSearchParams();
  const pathname = usePathname();
  const { openDetail } = useDetailModal();
  const title = params.get("title");

  useEffect(() => {
    if (pathname !== "/browse" || !title) return;
    const item = titleFromLink(`/browse?${params.toString()}`);
    const rest = new URLSearchParams(params.toString());
    rest.delete("title");
    rest.delete("season");
    // Native replaceState is synced with the Next.js router and takes effect immediately.
    window.history.replaceState(window.history.state, "", rest.size ? `/browse?${rest}` : "/browse");
    if (item) openDetail(item);
  }, [pathname, title, params, openDetail]);

  return null;
}
