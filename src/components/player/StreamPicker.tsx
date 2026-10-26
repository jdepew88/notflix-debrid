"use client";

import { ArrowLeft, HardDriveDownload, Play, Zap } from "lucide-react";
import type { TorrentioStreamOption } from "@/lib/torrentio";
import { cn } from "@/lib/cn";

interface StreamPickerProps {
  title: string;
  subtitle?: string;
  streams: TorrentioStreamOption[];
  onSelect: (index: number) => void;
  onCancel: () => void;
  openingIndex?: number | null;
  error?: string;
  hint?: string;
  /** Play (default) or download torrent list */
  variant?: "play" | "download";
}

export function StreamPicker({
  title,
  subtitle,
  streams,
  onSelect,
  onCancel,
  openingIndex = null,
  error,
  hint,
  variant = "play",
}: StreamPickerProps) {
  const isDownload = variant === "download";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center gap-4 border-b border-white/10 px-4 py-4 md:px-8">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full p-2 hover:bg-white/10"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold md:text-xl">{title}</h1>
          <p className="text-sm text-netflix-light-gray">
            {subtitle ??
              (isDownload
                ? "Choose a torrent to download via Real-Debrid"
                : "Choose a torrent source from Real-Debrid")}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {error && (
          <div className="mx-auto mb-4 max-w-3xl rounded bg-red-900/50 px-4 py-2 text-sm text-red-200">
            {error}
          </div>
        )}
        <p className="mb-4 text-sm text-netflix-light-gray">
          {hint ??
            `${streams.length} source${streams.length === 1 ? "" : "s"} found · sorted by quality`}
        </p>

        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {streams.map((stream) => {
            const opening = openingIndex === stream.index;
            return (
              <button
                key={stream.index}
                type="button"
                disabled={openingIndex !== null}
                onClick={() => onSelect(stream.index)}
                className={cn(
                  "group flex w-full items-start gap-4 rounded-lg border border-white/10 bg-white/5 px-4 py-4 text-left transition hover:border-white/25 hover:bg-white/10 disabled:cursor-wait disabled:opacity-70",
                  stream.recommended && "border-netflix-red/40 bg-netflix-red/5"
                )}
              >
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 group-hover:bg-netflix-red">
                  {opening ? (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : isDownload ? (
                    <HardDriveDownload className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4 fill-current" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-medium text-white">{stream.label}</span>
                    {stream.quality && (
                      <span className="rounded bg-white/15 px-2 py-0.5 text-xs font-semibold uppercase">
                        {stream.quality}
                      </span>
                    )}
                    {stream.cached && (
                      <span className="flex items-center gap-1 rounded bg-green-900/50 px-2 py-0.5 text-xs text-green-300">
                        <Zap className="h-3 w-3" />
                        Cached
                      </span>
                    )}
                    {stream.recommended && (
                      <span className="rounded bg-netflix-red/20 px-2 py-0.5 text-xs text-netflix-red">
                        Recommended
                      </span>
                    )}
                  </div>
                  {stream.detail && (
                    <p className="line-clamp-2 text-sm text-netflix-light-gray">{stream.detail}</p>
                  )}
                </div>

                <HardDriveDownload className="mt-1 h-4 w-4 shrink-0 text-netflix-gray opacity-0 transition group-hover:opacity-100" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
