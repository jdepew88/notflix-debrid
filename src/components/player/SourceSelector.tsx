"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Search, X, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { languageName, type ClientCapabilities } from "@/lib/playback-client";

/** Mirrors SourceCandidate in src/lib/source-candidates.ts (what /api/playback/sources returns). */
export interface SourceCandidateView {
  index: number;
  label: string;
  detail: string;
  quality?: string;
  cached: boolean;
  hash: string;
  traits: {
    resolution: number | null;
    sizeGb: number | null;
    videoCodec: string | null;
    hdr: boolean;
    dolbyVision: boolean;
    remux: boolean;
    audio: string | null;
    container: string | null;
  };
  hints: { codes: string[]; multi: boolean; likelyNonEnglishOnly: boolean };
  verified: {
    container: string;
    fileSize: number | null;
    video: { codec: string; width: number; height: number; bitDepth: number; frameRate: number | null; dynamicRange: string } | null;
    audio: Array<{ codec: string; channels: number; languageCode: string | null; title: string | null }>;
    audioLanguages: string[];
    subtitleLanguages: string[];
    untaggedAudioTracks: number;
  } | null;
  verifyError?: string;
}

export interface SourceSelectorProps {
  title: string;
  /** Query used to list and verify releases (tmdbId/type/season/episode/title…). */
  query: Record<string, string | number | undefined>;
  profileId?: string | null;
  client: ClientCapabilities;
  currentHash?: string | null;
  /** Local self-test samples instead of Real-Debrid releases (tests). */
  sample?: boolean;
  onSelect: (candidate: SourceCandidateView) => Promise<boolean>;
  onClose: () => void;
}

/** What the engine would have to do for this browser (estimate from verified streams). */
export function estimateCompatibility(v: NonNullable<SourceCandidateView["verified"]>, caps: ClientCapabilities): { label: string; level: "direct" | "remux" | "audio" | "video" } {
  const codec = v.video?.codec?.toLowerCase() ?? "";
  const videoOk = caps.mseVideo.includes(codec === "h265" ? "hevc" : codec) && !(v.video && v.video.bitDepth > 8 && !caps.tenBit.includes(codec));
  const audioOk = v.audio.some((a) => caps.mseAudio.includes(a.codec.toLowerCase()));
  if (!videoOk) return { label: "Converts video (GPU)", level: "video" };
  if (!audioOk) return { label: "Converts audio", level: "audio" };
  if (v.container === "mp4" || v.container === "webm") return { label: "Plays directly", level: "direct" };
  return { label: "Plays directly (repackaged)", level: "remux" };
}

const fmtGb = (gb: number | null | undefined) => (gb == null ? null : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`);
const fmtBytes = (b: number | null) => (b == null ? null : fmtGb(b / 1e9));
const codecName = (c: string | null | undefined) =>
  ({ h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", aac: "AAC", ac3: "AC-3", eac3: "E-AC-3", dts: "DTS", truehd: "TrueHD", atmos: "Atmos", opus: "Opus", flac: "FLAC", mp3: "MP3", pcm_s24le: "PCM", pcm_s16le: "PCM" } as Record<string, string>)[(c ?? "").toLowerCase()] ?? (c ?? "").toUpperCase();
const channels = (n: number) => (n >= 8 ? "7.1" : n >= 6 ? "5.1" : n === 1 ? "Mono" : "2.0");

export function SourceSelector({ title, query, profileId, client, currentHash, sample, onSelect, onClose }: SourceSelectorProps) {
  const [candidates, setCandidates] = useState<SourceCandidateView[]>([]);
  const [preferred, setPreferred] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<Set<number>>(new Set());
  const [switching, setSwitching] = useState<number | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const queryKey = JSON.stringify(query);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") p.set(k, String(v));
    if (profileId) p.set("profileId", profileId);
    if (client.mseVideo.includes("hevc")) p.set("hevc", "1");
    if (sample) p.set("sample", "1");
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, profileId, sample]);

  const verify = useCallback(
    async (index: number) => {
      setVerifying((s) => new Set(s).add(index));
      try {
        const res = await fetch("/api/playback/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...query, streamIndex: index, profileId, sample: sample || undefined }),
        });
        const data = await res.json();
        if (!mountedRef.current) return;
        setCandidates((prev) => prev.map((c) => (c.index === index ? { ...c, verified: data.verified ?? c.verified, verifyError: data.verifyError ?? (data.verified ? undefined : c.verifyError) } : c)));
      } catch {
        if (mountedRef.current) setCandidates((prev) => prev.map((c) => (c.index === index ? { ...c, verifyError: "Could not check this release" } : c)));
      } finally {
        if (mountedRef.current) setVerifying((s) => { const n = new Set(s); n.delete(index); return n; });
      }
    },
    [query, profileId, sample]
  );

  // A new query shows the loading state before the fetch effect runs (derived-state pattern).
  const [activeParams, setActiveParams] = useState(params);
  if (activeParams !== params) {
    setActiveParams(params);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/playback/sources?${params}`).catch(() => null);
      if (cancelled) return;
      if (!res) { setError("Could not reach the server."); setLoading(false); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Could not load sources (${res.status}).`); setLoading(false); return; }
      const list = (data.candidates ?? []) as SourceCandidateView[];
      setCandidates(list);
      setPreferred(data.preferred ?? []);
      setLoading(false);
      // Staged verification: the first few unverified cached releases, two at a time.
      const todo = list.filter((c) => !c.verified && c.cached).slice(0, 4).map((c) => c.index);
      for (let i = 0; i < todo.length; i += 2) {
        if (cancelled) return;
        await Promise.all(todo.slice(i, i + 2).map((idx) => verify(idx)));
      }
    })();
    return () => { cancelled = true; };
  }, [params, verify]);

  const choose = async (c: SourceCandidateView) => {
    setSwitching(c.index);
    setSwitchError(null);
    const ok = await onSelect(c);
    if (!mountedRef.current) return;
    setSwitching(null);
    if (!ok) setSwitchError(`Couldn't start "${c.label}". You're still watching the current source.`);
  };

  const sorted = useMemo(() => {
    const wants = new Set(preferred);
    const rank = (c: SourceCandidateView) => {
      if (c.verified) return c.verified.audioLanguages.some((l) => wants.has(l)) ? 0 : c.verified.audioLanguages.length === 0 ? 2 : 3;
      return c.hints.likelyNonEnglishOnly && !c.hints.codes.some((l) => wants.has(l)) ? 4 : 1;
    };
    return [...candidates].sort((a, b) => rank(a) - rank(b) || (Number(b.cached) - Number(a.cached)) || a.index - b.index);
  }, [candidates, preferred]);

  return (
    <div className="absolute inset-0 z-[85] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6" onClick={onClose} role="dialog" aria-label="Change video source" data-testid="source-selector">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-t-xl bg-[#141414] shadow-2xl ring-1 ring-white/10 sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Change video source</h2>
            <p className="truncate text-sm text-netflix-light-gray">{title}{preferred.length ? ` · prefers ${preferred.map(languageName).join(", ")} audio` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        {switchError && <p className="mx-4 mt-3 rounded bg-red-900/40 px-3 py-2 text-sm text-red-200" data-testid="switch-error">{switchError}</p>}
        {error && <p className="mx-4 mt-3 rounded bg-yellow-900/30 px-3 py-2 text-sm text-yellow-100">{error}</p>}

        <div className="flex-1 overflow-y-auto p-2 sm:p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-netflix-light-gray"><Loader2 className="h-5 w-5 animate-spin" /> Finding releases…</div>
          )}
          {!loading && candidates.length === 0 && !error && <p className="py-12 text-center text-sm text-netflix-light-gray">No other releases were found for this title.</p>}
          <ul className="space-y-2">
            {sorted.map((c) => {
              const isCurrent = currentHash != null && c.hash === currentHash;
              const v = c.verified;
              const compat = v ? estimateCompatibility(v, client) : null;
              const hasPreferred = v ? v.audioLanguages.some((l) => preferred.includes(l)) : null;
              return (
                <li key={c.hash} className={cn("rounded-lg border p-3", isCurrent ? "border-netflix-red/60 bg-netflix-red/10" : "border-white/10 bg-white/[0.03]")} data-testid="source-candidate" data-hash={c.hash}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium leading-snug">{c.label}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                        {isCurrent && <span className="rounded bg-netflix-red px-1.5 py-0.5 font-semibold">Current</span>}
                        {c.cached ? <span className="flex items-center gap-0.5 rounded bg-emerald-900/50 px-1.5 py-0.5 text-emerald-200"><Zap className="h-3 w-3" />Instant</span> : <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">Needs download</span>}
                        {(v?.video ? `${v.video.height >= 2000 ? "2160" : v.video.height}p` : c.quality) && <span className="rounded bg-zinc-800 px-1.5 py-0.5">{v?.video ? `${v.video.height >= 2000 ? "2160" : v.video.height}p` : c.quality}</span>}
                        {(v ? fmtBytes(v.fileSize) : fmtGb(c.traits.sizeGb)) && <span className="rounded bg-zinc-800 px-1.5 py-0.5">{v ? fmtBytes(v.fileSize) : fmtGb(c.traits.sizeGb)}</span>}
                      </div>

                      {v ? (
                        <div className="mt-2 space-y-1 text-xs text-netflix-light-gray" data-testid="verified">
                          <p>
                            <span className="text-emerald-300">Verified:</span> {v.container.toUpperCase()} · {codecName(v.video?.codec)}{v.video && v.video.bitDepth > 8 ? ` ${v.video.bitDepth}-bit` : ""}{v.video?.dynamicRange && v.video.dynamicRange !== "SDR" ? ` ${v.video.dynamicRange}` : ""}{v.video?.frameRate ? ` · ${v.video.frameRate} fps` : ""}
                          </p>
                          <p className="flex flex-wrap gap-1">
                            <span>Audio:</span>
                            {v.audio.length === 0 && <span>none</span>}
                            {v.audio.map((a, i) => (
                              <span key={i} className={cn("rounded px-1.5 py-0.5", a.languageCode && preferred.includes(a.languageCode) ? "bg-emerald-900/60 text-emerald-100" : "bg-zinc-800")}>
                                {a.languageCode ? languageName(a.languageCode) : "Unknown language"} · {codecName(a.codec)} {channels(a.channels)}
                              </span>
                            ))}
                          </p>
                          <p>Subtitles: {v.subtitleLanguages.length ? v.subtitleLanguages.map(languageName).join(", ") : "none embedded"}</p>
                          {compat && <p className={cn(compat.level === "video" ? "text-amber-200" : "text-netflix-light-gray")}>{compat.label}</p>}
                          {hasPreferred === false && v.audioLanguages.length > 0 && <p className="text-amber-200">No {preferred.map(languageName).join("/")} audio in this release.</p>}
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-netflix-gray">
                          {c.verifyError ? (
                            <p className="text-amber-200/90">{c.verifyError}</p>
                          ) : (
                            <p>
                              From the name (unverified): {[c.traits.videoCodec && codecName(c.traits.videoCodec), c.traits.hdr && "HDR", c.traits.dolbyVision && "Dolby Vision", c.traits.audio && codecName(c.traits.audio), c.hints.codes.length ? `languages: ${c.hints.codes.map(languageName).join(", ")}` : "language unknown"].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!v && (
                        <button type="button" onClick={() => void verify(c.index)} disabled={verifying.has(c.index)} className="flex items-center gap-1 rounded border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50" data-testid="verify">
                          {verifying.has(c.index) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Check
                        </button>
                      )}
                      {isCurrent ? (
                        <span className="flex items-center gap-1 text-xs text-netflix-light-gray"><Check className="h-4 w-4" /> Playing</span>
                      ) : (
                        <button type="button" onClick={() => void choose(c)} disabled={switching != null} className="rounded bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-white/80 disabled:opacity-50" data-testid="play-source">
                          {switching === c.index ? "Starting…" : "Play this"}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
