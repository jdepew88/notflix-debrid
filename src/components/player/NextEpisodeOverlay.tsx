"use client";

import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";

interface NextEpisodeOverlayProps {
  onPlay: () => void;
  onDismiss: () => void;
  seconds?: number;
}

export function NextEpisodeOverlay({
  onPlay,
  onDismiss,
  seconds = 5,
}: NextEpisodeOverlayProps) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (remaining <= 0) {
      onPlay();
      return;
    }
    const timer = window.setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, onPlay]);

  return (
    <div className="absolute bottom-24 right-4 z-40 w-72 rounded-lg bg-[#181818]/95 p-4 shadow-2xl ring-1 ring-white/10 md:bottom-28 md:right-8">
      <div className="mb-3 flex items-start justify-between gap-2">
        <p className="text-sm font-medium">Next episode</p>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 hover:bg-white/10"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <button
        type="button"
        onClick={onPlay}
        className="flex w-full items-center justify-center gap-2 rounded bg-white py-2 text-sm font-semibold text-black hover:bg-white/90"
      >
        <Play className="h-4 w-4 fill-current" />
        Play now ({remaining}s)
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 w-full py-1 text-xs text-netflix-light-gray hover:text-white"
      >
        Watch credits
      </button>
    </div>
  );
}
