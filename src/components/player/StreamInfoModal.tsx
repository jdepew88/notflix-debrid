"use client";

import { X } from "lucide-react";
import type { StreamPlaybackInfo } from "@/types/stream-info";

interface StreamInfoModalProps {
  info: StreamPlaybackInfo;
  live?: {
    width?: number;
    height?: number;
    duration?: number;
    currentTime?: number;
    buffered?: number;
    playing?: boolean;
    audioSyncMs?: number;
    externalSubtitle?: string | null;
  };
  onClose: () => void;
}

function row(label: string, value: string | number | boolean | null | undefined) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 border-b border-white/5 py-2 text-sm">
      <span className="text-netflix-gray">{label}</span>
      <span className="break-all font-mono text-xs text-white">{String(value)}</span>
    </div>
  );
}

export function StreamInfoModal({ info, live, onClose }: StreamInfoModalProps) {
  const selectedAudio = info.audioTracks?.find((t) => t.index === info.audioIndex);
  const selectedSub =
    info.subtitleIndex === null
      ? null
      : info.subtitleTracks?.find((t) => t.index === info.subtitleIndex);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-zinc-900 p-5 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Stream information</h3>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {row("Stream URL", info.streamUrl)}
        {row("Source URL", info.sourceUrl)}
        {row("Library path", info.sourcePath)}
        {row("Direct play", info.isDirectPlay ? "yes" : "no")}
        {row("Needs transcode", info.needsTranscode ? "yes" : "no")}
        {row("Container", info.format)}
        {row("Video codec", info.videoCodec)}
        {row("Quality hint", info.qualityHint)}
        {row("Audio track", selectedAudio?.label)}
        {row("Subtitle track", selectedSub?.label ?? (info.subtitleIndex === null ? "off" : undefined))}
        {row("External subtitle", live?.externalSubtitle)}
        {row("Resolution", live?.width && live?.height ? `${live.width}×${live.height}` : undefined)}
        {row("Duration", live?.duration ? `${Math.floor(live.duration)}s` : undefined)}
        {row("Position", live?.currentTime !== undefined ? `${live.currentTime.toFixed(1)}s` : undefined)}
        {row("Buffered ahead", live?.buffered !== undefined ? `${live.buffered.toFixed(1)}s` : undefined)}
        {row("Playing", live?.playing)}
        {row("Audio sync offset", live?.audioSyncMs !== undefined ? `${live.audioSyncMs} ms` : undefined)}

        {info.audioTracks && info.audioTracks.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-netflix-gray">
              All audio tracks
            </p>
            {info.audioTracks.map((t) => (
              <p key={t.index} className="font-mono text-xs text-netflix-light-gray">
                {t.index}: {t.label}
              </p>
            ))}
          </div>
        )}

        {info.subtitleTracks && info.subtitleTracks.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-netflix-gray">
              Embedded subtitles
            </p>
            {info.subtitleTracks.map((t) => (
              <p key={t.index} className="font-mono text-xs text-netflix-light-gray">
                {t.index}: {t.label}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
