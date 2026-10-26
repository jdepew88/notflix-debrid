"use client";

import { useEffect, useRef, useState } from "react";
import { Languages, Volume2, ChevronUp, Upload, Settings2 } from "lucide-react";
import type { StreamTrack } from "@/types/media-tracks";
import { cn } from "@/lib/cn";
import type { SubtitleStyle } from "@/lib/profile-preferences";

function isEnglishTrack(track: StreamTrack): boolean {
  const lang = (track.language || track.title || "").toLowerCase();
  return lang === "en" || lang === "eng" || lang.startsWith("en-") || lang.includes("english");
}

function sortSubtitleTracks(tracks: StreamTrack[]): StreamTrack[] {
  return [...tracks].sort((a, b) => {
    const aEn = isEnglishTrack(a);
    const bEn = isEnglishTrack(b);
    if (aEn !== bEn) return aEn ? -1 : 1;
    return a.index - b.index;
  });
}

interface TrackSelectorProps {
  audioTracks: StreamTrack[];
  subtitleTracks: StreamTrack[];
  audioIndex: number;
  subtitleIndex: number | null;
  onAudioChange?: (index: number) => void;
  onSubtitleChange?: (index: number | null) => void;
  onExternalSubtitle?: (file: File) => void;
  externalSubtitleName?: string | null;
  disabled?: boolean;
  /** Subtitle appearance/timing (profile preferences). */
  subtitleStyle?: SubtitleStyle;
  onSubtitleStyleChange?: (style: SubtitleStyle) => void;
  subtitleOffsetMs?: number;
  onSubtitleOffsetChange?: (ms: number) => void;
  forcedOnly?: boolean;
  onForcedOnlyChange?: (value: boolean) => void;
  /** Lets the player keep its controls visible while the menu is open. */
  onOpenChange?: (open: boolean) => void;
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="px-4 py-1.5">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-netflix-gray">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map(([v, l]) => (
          <button key={v} type="button" onClick={() => onChange(v)} className={cn("rounded px-2 py-0.5 text-xs", value === v ? "bg-white text-black" : "bg-white/10 hover:bg-white/20")}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TrackSelector({
  audioTracks,
  subtitleTracks,
  audioIndex,
  subtitleIndex,
  onAudioChange,
  onSubtitleChange,
  onExternalSubtitle,
  externalSubtitleName,
  disabled,
  subtitleStyle,
  onSubtitleStyleChange,
  subtitleOffsetMs = 0,
  onSubtitleOffsetChange,
  forcedOnly,
  onForcedOnlyChange,
  onOpenChange,
}: TrackSelectorProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  const [tab, setTab] = useState<"audio" | "sub" | "options">("audio");
  const hasOptions = Boolean(subtitleStyle && onSubtitleStyleChange);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sortedSubs = sortSubtitleTracks(subtitleTracks);
  const hasAudio = audioTracks.length > 0;
  const hasSubs = subtitleTracks.length > 0 || Boolean(onExternalSubtitle);

  if (!hasAudio && !hasSubs) return null;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-white hover:text-netflix-light-gray disabled:opacity-50"
        title="Audio & Subtitles"
      >
        <Languages className="h-5 w-5" />
        <ChevronUp className={cn("h-3 w-3 transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-80 rounded bg-black/95 py-2 shadow-xl ring-1 ring-white/10" data-testid="track-menu">
          <div className="mb-2 flex border-b border-white/10">
            {hasAudio && (
              <button
                type="button"
                onClick={() => setTab("audio")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 py-2 text-sm",
                  tab === "audio" ? "text-white" : "text-netflix-gray"
                )}
              >
                <Volume2 className="h-4 w-4" />
                Audio
              </button>
            )}
            {hasSubs && (
              <button
                type="button"
                onClick={() => setTab("sub")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 py-2 text-sm",
                  tab === "sub" ? "text-white" : "text-netflix-gray"
                )}
              >
                <Languages className="h-4 w-4" />
                Subtitles
              </button>
            )}
            {hasOptions && (
              <button
                type="button"
                onClick={() => setTab("options")}
                className={cn("flex flex-1 items-center justify-center gap-1 py-2 text-sm", tab === "options" ? "text-white" : "text-netflix-gray")}
                title="Subtitle options"
              >
                <Settings2 className="h-4 w-4" />
                Options
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {tab === "options" && hasOptions && subtitleStyle && (
              <div className="py-1">
                <Choice label="Size" value={subtitleStyle.size} options={[["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["xlarge", "Extra large"]]} onChange={(size) => onSubtitleStyleChange!({ ...subtitleStyle, size })} />
                <Choice label="Color" value={subtitleStyle.color} options={[["white", "White"], ["yellow", "Yellow"], ["cyan", "Cyan"]]} onChange={(color) => onSubtitleStyleChange!({ ...subtitleStyle, color })} />
                <Choice label="Background" value={subtitleStyle.background} options={[["none", "None"], ["semi", "Shaded"], ["solid", "Solid"]]} onChange={(background) => onSubtitleStyleChange!({ ...subtitleStyle, background })} />
                <Choice label="Edge" value={subtitleStyle.edge} options={[["none", "None"], ["outline", "Outline"], ["shadow", "Shadow"]]} onChange={(edge) => onSubtitleStyleChange!({ ...subtitleStyle, edge })} />
                {onSubtitleOffsetChange && (
                  <div className="px-4 py-1.5">
                    <p className="mb-1 text-[11px] uppercase tracking-wide text-netflix-gray">Timing</p>
                    <div className="flex items-center gap-2 text-xs">
                      <button type="button" onClick={() => onSubtitleOffsetChange(subtitleOffsetMs - 250)} className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">−0.25 s</button>
                      <span className="min-w-[5.5rem] text-center font-mono" data-testid="subtitle-offset">{subtitleOffsetMs === 0 ? "in sync" : `${subtitleOffsetMs > 0 ? "+" : ""}${(subtitleOffsetMs / 1000).toFixed(2)} s`}</span>
                      <button type="button" onClick={() => onSubtitleOffsetChange(subtitleOffsetMs + 250)} className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">+0.25 s</button>
                      {subtitleOffsetMs !== 0 && <button type="button" onClick={() => onSubtitleOffsetChange(0)} className="ml-auto text-netflix-light-gray hover:text-white">Reset</button>}
                    </div>
                  </div>
                )}
                {onForcedOnlyChange && (
                  <label className="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm">
                    <input type="checkbox" checked={Boolean(forcedOnly)} onChange={(e) => onForcedOnlyChange(e.target.checked)} className="h-4 w-4 accent-netflix-red" />
                    Prefer forced subtitles (foreign parts only)
                  </label>
                )}
              </div>
            )}
            {tab === "audio" &&
              hasAudio &&
              audioTracks.map((track) => (
                <button
                  key={track.index}
                  type="button"
                  onClick={() => {
                    onAudioChange?.(track.index);
                    setOpen(false);
                  }}
                  className={cn(
                    "block w-full px-4 py-2 text-left text-sm hover:bg-white/10",
                    audioIndex === track.index && "text-netflix-red"
                  )}
                >
                  {track.label}
                </button>
              ))}

            {tab === "sub" && hasSubs && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onSubtitleChange?.(null);
                    setOpen(false);
                  }}
                  className={cn(
                    "block w-full px-4 py-2 text-left text-sm hover:bg-white/10",
                    subtitleIndex === null && !externalSubtitleName && "text-netflix-red"
                  )}
                >
                  Off
                </button>
                {sortedSubs.map((track) => (
                  <button
                    key={track.index}
                    type="button"
                    onClick={() => {
                      onSubtitleChange?.(track.index);
                      setOpen(false);
                    }}
                    className={cn(
                      "block w-full px-4 py-2 text-left text-sm hover:bg-white/10",
                      subtitleIndex === track.index && "text-netflix-red"
                    )}
                  >
                    {track.label}
                  </button>
                ))}
                {externalSubtitleName && (
                  <p className="px-4 py-2 text-xs text-netflix-gray">
                    External: {externalSubtitleName}
                  </p>
                )}
                {onExternalSubtitle && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".srt,.vtt,text/vtt,application/x-subrip"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          onExternalSubtitle(file);
                          setOpen(false);
                        }
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/10"
                    >
                      <Upload className="h-4 w-4" />
                      Load external subtitle…
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
