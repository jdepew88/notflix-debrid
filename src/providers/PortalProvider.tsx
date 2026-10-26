"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { MediaItem } from "@/lib/types";

interface PortalContextValue {
  anchorElement: HTMLElement | null;
  item: MediaItem | null;
  setPortal: (anchor: HTMLElement | null, item: MediaItem | null) => void;
}

const PortalContext = createContext<PortalContextValue | null>(null);

export function PortalProvider({ children }: { children: ReactNode }) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const [item, setItem] = useState<MediaItem | null>(null);

  const setPortal = useCallback((anchor: HTMLElement | null, media: MediaItem | null) => {
    setAnchorElement(anchor);
    setItem(media);
  }, []);

  return (
    <PortalContext.Provider value={{ anchorElement, item, setPortal }}>
      {children}
    </PortalContext.Provider>
  );
}

export function usePortal() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error("usePortal must be used within PortalProvider");
  return ctx;
}
