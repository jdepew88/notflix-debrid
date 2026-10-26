"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { MediaItem } from "@/lib/types";

interface DetailModalState {
  open: boolean;
  item: MediaItem | null;
}

interface DetailModalContextValue extends DetailModalState {
  openDetail: (item: MediaItem) => void;
  closeDetail: () => void;
  /** Call before leaving for /watch from the details view: Back from the player reopens these details. */
  rememberForReturn: (item: MediaItem) => void;
}

const DetailModalContext = createContext<DetailModalContextValue | null>(null);
const RETURN_KEY = "notflix:details-return";

/** Just enough of the title to reopen its details (full data is fetched again). */
function slim(item: MediaItem): MediaItem {
  const { id, title, tmdbId, mediaType, type, source, posterPath, backdropPath, releaseDate, overview, genres, rating } = item;
  return { id, title, tmdbId, mediaType, type, source, posterPath, backdropPath, releaseDate, overview, genres, rating };
}

export function DetailModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DetailModalState>({ open: false, item: null });
  const pathname = usePathname();
  const previousPath = useRef(pathname);

  const openDetail = useCallback((item: MediaItem) => {
    setState({ open: true, item });
  }, []);

  const closeDetail = useCallback(() => {
    setState({ open: false, item: null });
  }, []);

  const rememberForReturn = useCallback((item: MediaItem) => {
    try {
      sessionStorage.setItem(RETURN_KEY, JSON.stringify({ path: window.location.pathname + window.location.search, item: slim(item) }));
    } catch {
      /* storage unavailable: Back simply returns to the page */
    }
  }, []);

  // Leaving for the player closes the details; coming back from it to the same page reopens them.
  useEffect(() => {
    const from = previousPath.current;
    previousPath.current = pathname;
    if (pathname.startsWith("/watch")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- route change closes the overlay
      setState({ open: false, item: null });
      return;
    }
    if (!from.startsWith("/watch")) return;
    try {
      const raw = sessionStorage.getItem(RETURN_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { path: string; item: MediaItem };
      if (saved.path === window.location.pathname + window.location.search) setState({ open: true, item: saved.item });
    } catch {
      /* ignore */
    }
  }, [pathname]);

  return (
    <DetailModalContext.Provider value={{ ...state, openDetail, closeDetail, rememberForReturn }}>
      {children}
    </DetailModalContext.Provider>
  );
}

export function useDetailModal() {
  const ctx = useContext(DetailModalContext);
  if (!ctx) throw new Error("useDetailModal must be used within DetailModalProvider");
  return ctx;
}
