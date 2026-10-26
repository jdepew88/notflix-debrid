"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Flag, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { EngineSessionView } from "@/lib/playback-client";

/** Client-side measurements collected by the player (no network calls). */
export interface ClientPlaybackStats {
  currentTime: number;
  movieTime: number;
  duration: number;
  bufferedAhead: number;
  bufferedRanges: Array<[number, number]>;
  videoWidth: number;
  videoHeight: number;
  droppedFrames: number | null;
  decodedFrames: number | null;
  startupMs: number | null;
  rebufferEvents: number;
  rebufferMs: number;
  /** HLS.js bandwidth estimate (estimate, bits/s). */
  bandwidthEstimate: number | null;
  /** Measured throughput of the last loaded segment (bits/s). */
  lastSegmentThroughput: number | null;
  lastSegmentLatencyMs: number | null;
  segmentErrors: number;
  playerKind: "hls.js" | "native-hls" | "progressive";
  hlsLevelCodecs: string | null;
  playing: boolean;
}

export interface StaticStreamInfo {
  title: string;
  session: EngineSessionView | null;
  provider?: string;
  streamLabel?: string | null;
  quality?: string | null;
  server?: { resolveMs: number; linkMs: number; engineMs: number; totalMs: number } | null;
  fallbackReason?: string | null;
  notices?: string[];
}

type Metrics = Record<string, unknown> & {
  processing?: Record<string, unknown>;
  gpu?: Record<string, unknown>;
  system?: Record<string, unknown>;
  network?: Record<string, unknown>;
  output?: Record<string, unknown>;
  source?: Record<string, unknown> & { video?: Record<string, unknown>; audio?: Array<Record<string, unknown>>; subtitles?: Array<Record<string, unknown>> };
  status?: Record<string, unknown>;
  decisionReasons?: string[];
  events?: Array<{ at: string; kind: string; message: string }>;
};

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmtBytes = (b: number | null) =>
  b == null ? null : b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const fmtMbps = (bps: number | null) => (bps == null ? null : `${(bps / 1e6).toFixed(1)} Mbps`);
const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const codecName = (c: unknown) => {
  const s = String(c ?? "").toLowerCase();
  return ({ h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8", mpeg2video: "MPEG-2", mpeg4: "MPEG-4", vc1: "VC-1", aac: "AAC", ac3: "AC-3", eac3: "E-AC-3", dts: "DTS", truehd: "TrueHD", opus: "Opus", flac: "FLAC", mp3: "MP3" } as Record<string, string>)[s] ?? s.toUpperCase();
};

/** Measured vs estimated vs unavailable, shown next to each value. */
type Quality = "measured" | "estimate" | "n/a";

function Row({ label, value, q }: { label: string; value: React.ReactNode; q?: Quality }) {
  const missing = value === null || value === undefined || value === "";
  return (
    <div className="grid grid-cols-[minmax(8rem,11rem)_1fr_auto] items-baseline gap-2 border-b border-white/5 py-1.5 text-xs">
      <span className="text-netflix-gray">{label}</span>
      <span className={cn("break-all font-mono", missing ? "text-white/30" : "text-white")}>{missing ? "unavailable" : value}</span>
      {q && !missing && <span className={cn("rounded px-1 text-[10px] uppercase", q === "measured" ? "text-emerald-400/80" : "text-amber-300/80")}>{q}</span>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-netflix-light-gray">{title}</h3>
      {children}
    </section>
  );
}

export function buildDiagnosticsReport(info: StaticStreamInfo, client: ClientPlaybackStats, metrics: Metrics | null) {
  // Deliberately excludes URLs, tokens and session secrets: only ids, codecs and measurements.
  return {
    generatedAt: new Date().toISOString(),
    title: info.title,
    provider: info.provider,
    release: info.streamLabel,
    sessionId: info.session?.id ?? null,
    mode: info.session?.modeLabel ?? (info.fallbackReason ? "Direct (engine offline)" : null),
    decision: info.session?.decision ?? null,
    serverTiming: info.server ?? null,
    client: { ...client, bufferedRanges: client.bufferedRanges.slice(0, 10), userAgent: navigator.userAgent },
    engine: metrics
      ? {
          source: metrics.source,
          output: metrics.output,
          processing: metrics.processing,
          gpu: metrics.gpu,
          system: metrics.system,
          network: metrics.network,
          status: metrics.status,
          reasons: metrics.decisionReasons,
          events: metrics.events,
        }
      : null,
  };
}

/** Vendor name of a hardware encoder ("h264_nvenc" → "NVENC"). */
function encoderFamily(encoder: string): string | null {
  const m = /_(nvenc|qsv|amf|vaapi|videotoolbox)$/.exec(encoder);
  if (!m) return null;
  return { nvenc: "NVENC", qsv: "Quick Sync", amf: "AMD AMF", vaapi: "VA-API", videotoolbox: "VideoToolbox" }[m[1]] ?? null;
}

export function StreamDiagnosticsPanel({
  info,
  stats,
  initialTab = "info",
  onClose,
}: {
  info: StaticStreamInfo;
  stats: () => ClientPlaybackStats;
  initialTab?: "info" | "stats";
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [client, setClient] = useState<ClientPlaybackStats>(stats);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionId = info.session?.id;

  // Live refresh: client stats every second, engine metrics every 2 s, only while the panel is open.
  useEffect(() => {
    const id = window.setInterval(() => setClient(stats()), 1000);
    return () => window.clearInterval(id);
  }, [stats]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = async () => {
      const res = await fetch(`/api/playback/${sessionId}/metrics`).catch(() => null);
      if (!cancelled && res?.ok) setMetrics(await res.json());
    };
    void load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId]);

  const s = info.session;
  const src = (metrics?.source ?? s?.source ?? {}) as Metrics["source"] & Record<string, unknown>;
  const sv = (src?.video ?? {}) as Record<string, unknown>;
  const p = metrics?.processing ?? {};
  const g = metrics?.gpu ?? {};
  const net = metrics?.network ?? {};
  const out = metrics?.output ?? {};
  const transcoding = s?.decision.video === "Transcode";
  const hwFamily = encoderFamily(String(p.encoder ?? ""));
  const outCodec = transcoding ? `${p.hardwareEncode && hwFamily ? `${hwFamily} ` : ""}${codecName(s?.decision.outputVideoCodec)}` : codecName(s?.decision.outputVideoCodec ?? sv.codec);
  const playbackBps = n(out.measuredBitrateKbps) != null ? n(out.measuredBitrateKbps)! * 1000 : client.lastSegmentThroughput;

  const summary = useMemo(() => {
    const parts: string[] = [];
    const h = n(sv.height) ?? client.videoHeight;
    if (h) parts.push(`${h >= 2000 ? 2160 : h}p`);
    if (sv.codec) parts.push(`${codecName(sv.codec)} source${sv.dynamicRange && sv.dynamicRange !== "SDR" ? ` (${sv.dynamicRange})` : ""}`);
    if (s) parts.push(s.mode === "DirectPlay" ? "Direct Play" : s.mode === "Remux" ? "Remux" : transcoding ? `${outCodec} output` : "Audio converted");
    const kbps = n(out.measuredBitrateKbps) ?? (n(src?.bitrateKbps) ?? null);
    if (kbps) parts.push(`${(kbps / 1000).toFixed(1)} Mbps`);
    parts.push(`${Math.round(client.bufferedAhead)} seconds buffered`);
    return parts.join(" • ");
  }, [sv, client, s, transcoding, outCodec, out, src]);

  const copy = async () => {
    const text = JSON.stringify(buildDiagnosticsReport(info, client, metrics), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Diagnostics copied to the clipboard.");
    } catch {
      setNotice("Clipboard unavailable — diagnostics printed to the browser console.");
      console.info(text);
    }
  };

  const report = async () => {
    const res = await fetch("/api/playback/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDiagnosticsReport(info, client, metrics)),
    }).catch(() => null);
    setNotice(res?.ok ? "Thanks — the problem report was saved on the server." : "Could not save the report.");
  };

  return (
    <div
      className="absolute inset-y-0 right-0 z-[80] flex w-full max-w-md flex-col bg-black/90 shadow-2xl ring-1 ring-white/10 backdrop-blur"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Stream information"
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
        <div>
          <p className="text-sm font-semibold">Stream information</p>
          <p className="mt-1 text-xs text-netflix-light-gray" data-testid="diagnostics-summary">{summary}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex gap-1 border-b border-white/10 px-4 text-xs">
        {(["info", "stats"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={cn("px-3 py-2", tab === t ? "border-b-2 border-netflix-red text-white" : "text-netflix-gray hover:text-white")}>
            {t === "info" ? "Source & playback" : "Buffering & processing"}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {info.fallbackReason && <p className="mb-3 rounded bg-yellow-900/40 p-2 text-xs text-yellow-200">{info.fallbackReason}</p>}
        {tab === "info" ? (
          <>
            <Section title="Source">
              <Row label="Title" value={info.title} />
              <Row label="Provider" value={info.provider === "real-debrid" ? "Real-Debrid" : info.provider} />
              <Row label="Release" value={info.streamLabel} />
              <Row label="File" value={src?.fileName as string} />
              <Row label="File size" value={fmtBytes(n(src?.fileSize))} q="measured" />
              <Row label="Container" value={src?.container ? String(src.container).toUpperCase() : null} />
              <Row label="Video codec" value={sv.codec ? `${codecName(sv.codec)}${sv.profile ? ` (${sv.profile})` : ""}${n(sv.bitDepth) && n(sv.bitDepth)! > 8 ? ` ${sv.bitDepth}-bit` : ""}` : null} />
              <Row label="Resolution" value={n(sv.width) ? `${sv.width}×${sv.height}` : null} />
              <Row label="Frame rate" value={n(sv.frameRate) ? `${sv.frameRate} fps` : null} />
              <Row label="Bitrate" value={n(src?.bitrateKbps) ? `${(n(src?.bitrateKbps)! / 1000).toFixed(1)} Mbps` : null} q="measured" />
              <Row label="Dynamic range" value={(sv.dynamicRange as string) ?? null} />
              <Row label="Audio tracks" value={(src?.audio ?? []).map((a) => `${codecName(a.codec)} ${a.channels ?? ""}ch ${a.language ?? ""}`.trim()).join(", ") || null} />
              <Row label="Subtitle tracks" value={(src?.subtitles ?? []).map((t) => `${t.language ?? "und"} (${t.codec})`).join(", ") || "none"} />
            </Section>
            <Section title="Playback">
              <Row label="Mode" value={s?.modeLabel ?? (info.fallbackReason ? "Direct (engine offline)" : null)} />
              <Row label="Why" value={s?.decision.reasons.join("; ")} />
              <Row label="Decoded resolution" value={client.videoWidth ? `${client.videoWidth}×${client.videoHeight}` : null} q="measured" />
              <Row label="Output" value={s ? `${outCodec} ${s.decision.width}×${s.decision.height}` : null} />
              <Row label="Output audio" value={s ? codecName(s.decision.outputAudioCodec) : null} />
              <Row label="Playback bitrate" value={fmtMbps(playbackBps)} q={n(out.measuredBitrateKbps) != null ? "measured" : "estimate"} />
              <Row label="Selected quality" value={info.quality} />
              <Row label="Browser decoder" value={client.hlsLevelCodecs ?? (client.playerKind === "progressive" ? "native <video>" : null)} />
              <Row label="Player" value={client.playerKind} />
              <Row label="Session" value={s?.id} />
            </Section>
          </>
        ) : (
          <>
            <Section title="Buffering & performance">
              <Row label="Position" value={`${fmtTime(client.movieTime)} / ${client.duration ? fmtTime(client.duration) : "?"}`} q="measured" />
              <Row label="Buffered ahead" value={`${client.bufferedAhead.toFixed(1)} s`} q="measured" />
              <Row label="Buffered ranges" value={client.bufferedRanges.map(([a, b]) => `${fmtTime(a)}–${fmtTime(b)}`).join(", ") || null} q="measured" />
              <Row label="Startup delay" value={client.startupMs != null ? `${(client.startupMs / 1000).toFixed(2)} s` : null} q="measured" />
              <Row label="Server prep" value={info.server ? `${(info.server.totalMs / 1000).toFixed(2)} s (search ${info.server.resolveMs} ms, link ${info.server.linkMs} ms, engine ${info.server.engineMs} ms)` : null} q="measured" />
              <Row label="Rebuffer events" value={client.rebufferEvents} q="measured" />
              <Row label="Rebuffer time" value={`${(client.rebufferMs / 1000).toFixed(1)} s`} q="measured" />
              <Row label="Dropped frames" value={client.droppedFrames} q="measured" />
              <Row label="Decoded frames" value={client.decodedFrames} q="measured" />
              <Row label="Throughput (last segment)" value={fmtMbps(client.lastSegmentThroughput)} q="measured" />
              <Row label="Bandwidth estimate" value={fmtMbps(client.bandwidthEstimate)} q="estimate" />
              <Row label="Segment latency" value={client.lastSegmentLatencyMs != null ? `${Math.round(client.lastSegmentLatencyMs)} ms` : null} q="measured" />
              <Row label="Engine segment wait" value={n(net.averageSegmentLatencyMs) != null ? `${net.averageSegmentLatencyMs} ms avg` : null} q="measured" />
              <Row label="Direct-play throughput" value={n(net.directThroughputMbps) != null ? `${net.directThroughputMbps} Mbps` : null} q="measured" />
              <Row label="Segment errors" value={client.segmentErrors} q="measured" />
            </Section>
            <Section title="Server processing">
              <Row label="Transcoding active" value={p.active === true ? "yes" : p.active === false ? "no" : null} />
              <Row label="Host" value={p.host as string} />
              <Row label="Pipeline" value={p.pipeline as string} />
              <Row label="Video / audio" value={p.videoAction ? `${p.videoAction} / ${p.audioAction}` : null} />
              <Row label="Video encoder" value={transcoding ? (p.hardwareEncode ? `${hwFamily ?? "GPU"} (${p.encoder})` : `CPU (${p.encoder})`) : "not used (no video encode)"} />
              <Row label="Video decoder" value={transcoding ? (p.hardwareDecode ? `GPU (${String(p.pipeline ?? "").split(" + ")[0]})` : "CPU") : "not used"} />
              <Row label="Tone mapping" value={p.tonemap && p.tonemap !== "None" ? String(p.tonemap) : transcoding ? "none" : null} />
              <Row label="Speed" value={n(p.speed) != null ? `${p.speed}× real time` : null} q="measured" />
              <Row label="Encoder fps" value={n(p.fps)} q="measured" />
              <Row label="Encoded until" value={n(p.encodedUntil) != null ? fmtTime(n(p.encodedUntil)!) : null} q="measured" />
              <Row label="Session status" value={p.state as string} />
              <Row label="First segment" value={n(p.firstSegmentMs) != null ? `${p.firstSegmentMs} ms` : null} q="measured" />
              <Row label="FFmpeg CPU" value={n(p.processCpuPercent) != null ? `${p.processCpuPercent}% of all cores` : null} q="measured" />
              <Row label="System CPU" value={n(metrics?.system?.cpuPercent) != null ? `${metrics?.system?.cpuPercent}%` : null} q="measured" />
              <Row label="GPU (overall)" value={n(g.utilizationPercent) != null ? `${g.utilizationPercent}% · ${g.name}` : null} q="measured" />
              <Row label="GPU video encode" value={n(g.encoderPercent) != null ? `${g.encoderPercent}%${n(g.peakEncoderPercentThisJob) ? ` (peak ${g.peakEncoderPercentThisJob}%)` : ""}` : null} q="measured" />
              <Row label="GPU video decode" value={n(g.decoderPercent) != null ? `${g.decoderPercent}%${n(g.peakDecoderPercentThisJob) ? ` (peak ${g.peakDecoderPercentThisJob}%)` : ""}` : null} q="measured" />
              <p className="mt-1 text-[10px] text-white/40">GPU figures are device-wide and only reported for NVIDIA cards (nvidia-smi), not per stream.</p>
              {metrics?.events?.length ? (
                <div className="mt-3 space-y-1 text-[11px] text-netflix-light-gray">
                  {metrics.events.slice(-6).map((e, i) => (
                    <p key={i}><span className="text-white/40">{new Date(e.at).toLocaleTimeString()}</span> {e.message}</p>
                  ))}
                </div>
              ) : null}
            </Section>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 p-3">
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">
          <Copy className="h-3.5 w-3.5" /> Copy diagnostics
        </button>
        <button type="button" onClick={() => void report()} className="flex items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">
          <Flag className="h-3.5 w-3.5" /> Report problem
        </button>
        {notice && <span className="text-[11px] text-netflix-light-gray">{notice}</span>}
      </div>
    </div>
  );
}
