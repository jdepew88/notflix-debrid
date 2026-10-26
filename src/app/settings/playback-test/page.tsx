"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Hls from "hls.js";
import { ArrowLeft, Check, Play, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { detectClientCapabilities, trackLabel, type ClientCapabilities, type EngineSessionView } from "@/lib/playback-client";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { SourceSelector, type SourceCandidateView } from "@/components/player/SourceSelector";
import { useEngineSession } from "@/hooks/useEngineSession";
import { useActivePreferences, useAppStore } from "@/lib/store";

/**
 * The real Notflix player driving an engine session, wired like the watch page (tracks, sidecar
 * subtitles, preferences, Change video source) but fed by local samples so tests are deterministic.
 */
function PlayerHarness({ session: initial, title: initialTitle, onClose }: { session: EngineSessionView; title: string; onClose: () => void }) {
  const [current, setCurrent] = useState<{ session: EngineSessionView; title: string }>({ session: initial, title: initialTitle });
  const engine = useEngineSession(current.session);
  const s = engine.state?.session ?? current.session;
  const prefs = useActivePreferences();
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const [subtitleIndex, setSubtitleIndex] = useState<number | null>(() => defaultSubtitle(initial, prefs));
  const [sourceOpen, setSourceOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const positionRef = useRef(0);
  const [prevSessionId, setPrevSessionId] = useState(s.id);
  if (prevSessionId !== s.id) {
    setPrevSessionId(s.id);
    setSubtitleIndex(defaultSubtitle(s, prefs));
  }

  useEffect(() => {
    (window as unknown as { __playerState?: () => { movieTime: number; sessionId: string } }).__playerState = () => ({
      movieTime: positionRef.current,
      sessionId: s.id,
    });
  }, [s.id]);

  const selectedAudio = s.tracks.selectedAudio ?? 0;
  const sidecar = useMemo(() => {
    if (subtitleIndex == null) return null;
    const track = s.tracks.subtitles.find((t) => t.index === subtitleIndex);
    if (!track || track.kind !== "text") return null;
    return { url: `/api/playback/${s.id}/subtitles/${subtitleIndex}`, sourceStartTime: s.sourceStartTime };
  }, [s, subtitleIndex]);

  const switchSource = async (c: SourceCandidateView): Promise<boolean> => {
    const w = window as unknown as { __failNextSwitch?: boolean };
    const name = w.__failNextSwitch ? "does-not-exist.mkv" : c.label;
    w.__failNextSwitch = false;
    const res = await fetch("/api/playback/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, client: detectClientCapabilities(), startSeconds: positionRef.current }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return false;
    setCurrent({ session: data.session as EngineSessionView, title: c.label });
    setSourceOpen(false);
    setNotice(`Switched to: ${c.label}`);
    window.setTimeout(() => setNotice(null), 4000);
    return true;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black" data-testid="player-harness">
      <button type="button" onClick={onClose} className="absolute left-4 top-4 z-50 rounded bg-black/60 px-3 py-2 text-sm">
        Close player
      </button>
      <VideoPlayer
        key={s.id}
        src={engine.state?.src ?? ""}
        title={current.title}
        timeline={{ offset: engine.state?.offset ?? 0, duration: s.durationSeconds }}
        onSeekRequest={s.output === "hls" ? engine.seek : undefined}
        onPositionReport={engine.reportPosition}
        onProgress={(seconds) => { positionRef.current = seconds; }}
        audioTracks={s.tracks.audio.map((t) => ({ index: t.index, type: "audio" as const, codec: t.codec, language: t.language, channels: t.channels, label: trackLabel(t, "audio") }))}
        subtitleTracks={s.tracks.subtitles.map((t) => ({ index: t.index, type: "subtitle" as const, codec: t.codec, language: t.language, forced: t.forced, label: trackLabel(t, "subtitle") }))}
        audioIndex={selectedAudio}
        subtitleIndex={subtitleIndex}
        onAudioChange={(index) => void engine.changeTracks(index, null)}
        onSubtitleChange={(index) => {
          setSubtitleIndex(index);
          const track = s.tracks.subtitles.find((t) => t.index === index);
          if (track?.kind === "image") void engine.changeTracks(selectedAudio, index);
        }}
        sidecarSubtitle={sidecar}
        isDirectPlay={s.mode === "DirectPlay"}
        trackSwitching={engine.busy}
        notice={notice}
        diagnostics={{ title: current.title, session: s, provider: "sample" }}
        onChangeSource={() => setSourceOpen(true)}
        subtitleStyle={prefs.subtitleStyle}
        onSubtitleStyleChange={(style) => updatePreferences({ subtitleStyle: style })}
        subtitleOffsetMs={prefs.subtitleOffsetMs}
        onSubtitleOffsetChange={(ms) => updatePreferences({ subtitleOffsetMs: ms })}
        forcedSubtitles={prefs.forcedSubtitles}
        onForcedSubtitlesChange={(v) => updatePreferences({ forcedSubtitles: v })}
      />
      {sourceOpen && (
        <SourceSelector
          title={current.title}
          query={{}}
          sample
          profileId={activeProfileId}
          client={detectClientCapabilities()}
          currentHash={`sample-${current.title}`}
          onSelect={switchSource}
          onClose={() => setSourceOpen(false)}
        />
      )}
    </div>
  );
}

/** Default subtitle track for the harness: the profile's language when subtitles are enabled. */
function defaultSubtitle(s: EngineSessionView, prefs: { subtitlesEnabled: boolean; subtitleLanguage: string }): number | null {
  if (!prefs.subtitlesEnabled || prefs.subtitleLanguage === "off") return null;
  const match = s.tracks.subtitles.find((t) => t.kind === "text" && t.languageCode === prefs.subtitleLanguage && !t.forced);
  return match?.index ?? null;
}

interface Sample {
  name: string;
  note: string;
  sizeBytes: number;
}

interface Result {
  name: string;
  ok: boolean;
  mode?: string;
  pipeline?: string | null;
  output?: string;
  decoded?: string;
  startupMs?: number;
  serverMs?: number;
  played?: number;
  seek?: string;
  error?: string;
}

const WAIT_PLAYED_SECONDS = 3;

/** Plays one URL in the given <video> and resolves once playback has really advanced. */
function playAndMeasure(video: HTMLVideoElement, url: string, hls: boolean, timeoutMs = 30_000) {
  return new Promise<{ startupMs: number; hlsInstance: Hls | null; codecs: string | null }>((resolve, reject) => {
    const t0 = performance.now();
    let instance: Hls | null = null;
    let startupMs = -1;
    const timer = window.setTimeout(() => finish(new Error("Timed out before playback advanced")), timeoutMs);
    const onPlaying = () => {
      if (startupMs < 0) startupMs = Math.round(performance.now() - t0);
    };
    const onTime = () => {
      if (startupMs >= 0 && video.currentTime >= WAIT_PLAYED_SECONDS) finish(null);
    };
    const onError = () => finish(new Error(video.error?.message || "Browser could not decode the stream"));
    function finish(err: Error | null) {
      window.clearTimeout(timer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("error", onError);
      if (err) {
        instance?.destroy();
        reject(err);
      } else {
        const level = instance?.levels?.[0];
        resolve({ startupMs, hlsInstance: instance, codecs: level ? [level.videoCodec, level.audioCodec].filter(Boolean).join(", ") : null });
      }
    }
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("error", onError);
    video.muted = true;
    if (hls && Hls.isSupported()) {
      instance = new Hls({ enableWorker: true, startPosition: 0, maxBufferLength: 20, liveDurationInfinity: true });
      instance.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) finish(new Error(`HLS error: ${data.details}`));
      });
      instance.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined));
      instance.loadSource(url);
      instance.attachMedia(video);
    } else {
      video.src = url;
      void video.play().catch(() => undefined);
    }
  });
}

/**
 * Seeks inside the current stream once it covers the target. A growing (EVENT) HLS playlist is only
 * re-read every target duration, so wait for the seekable range like the Notflix player does.
 */
async function seekNative(video: HTMLVideoElement, target: number, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  const end = () => (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0);
  while (end() < target && performance.now() < deadline) await new Promise((r) => window.setTimeout(r, 200));
  video.currentTime = target;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 8000);
    video.addEventListener("seeked", () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
  await new Promise((r) => window.setTimeout(r, 500));
}

export default function PlaybackTestPage() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [caps, setCaps] = useState<ClientCapabilities | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    void fetch("/api/playback/sample")
      .then((r) => r.json())
      .then((d) => {
        setCaps(detectClientCapabilities());
        setSamples(d.samples ?? []);
        setHint(d.generateHint ?? null);
      });
  }, []);

  const runOne = useCallback(async (sample: Sample): Promise<Result> => {
    const video = videoRef.current!;
    setRunning(sample.name);
    const t0 = performance.now();
    let session: EngineSessionView | null = null;
    let hls: Hls | null = null;
    try {
      const res = await fetch("/api/playback/sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sample.name, client: detectClientCapabilities() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `Engine returned ${res.status}`);
      session = data.session as EngineSessionView;
      const serverMs = Math.round(performance.now() - t0);
      const url = data.urls.manifest ?? data.urls.stream;
      const first = await playAndMeasure(video, url, session.output === "hls");
      hls = first.hlsInstance;
      const result: Result = {
        name: sample.name,
        ok: true,
        mode: session.modeLabel,
        pipeline: session.decision.pipeline,
        output: `${session.decision.outputVideoCodec}/${session.decision.outputAudioCodec} ${session.decision.width}×${session.decision.height}`,
        decoded: `${video.videoWidth}×${video.videoHeight}${first.codecs ? ` (${first.codecs})` : ""}`,
        startupMs: first.startupMs,
        serverMs,
        played: Math.round(video.currentTime * 10) / 10,
      };

      // Native seek inside what is already prepared (HLS seekable range or byte ranges).
      {
        const from = video.currentTime;
        await seekNative(video, from + 5);
        if (video.currentTime < from + 4) throw new Error(`Native seek ignored (stayed at ${video.currentTime.toFixed(1)} s)`);
        result.played = Math.round(video.currentTime * 10) / 10;
      }

      // Long samples: seek far ahead (beyond what is encoded) and confirm playback resumes there.
      if (/_long\./.test(sample.name)) {
        // 85% in, plus half a second so copy-mode restarts land between keyframes.
        const target = Math.round((session.durationSeconds ?? 240) * 0.85) + 0.5;
        if (session.output === "hls") {
          // Force a restart: fast remuxes may already have produced the target, but the restart path
          // (new generation starting mid-GOP, possibly on an open-GOP keyframe) must be exercised.
          const seekRes = await fetch(`/api/playback/${session.id}/seek`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ position: target, force: true }),
          });
          const seekData = await seekRes.json();
          if (!seekRes.ok) throw new Error(seekData.error || "Seek failed");
          if (!seekData.native) {
            hls?.destroy();
            const next = seekData.session as EngineSessionView;
            const resumed = await playAndMeasure(video, `/api/playback/${next.id}/manifest?generation=${next.generation}`, true);
            hls = resumed.hlsInstance;
            const at = next.generationStart + video.currentTime;
            result.seek = `restart → ${next.generationStart.toFixed(1)} s, resumed in ${resumed.startupMs} ms, now ${at.toFixed(1)} s`;
            if (next.generationStart > target + 0.5 || target - next.generationStart > 12) throw new Error(`Seek landed at ${next.generationStart}`);
          } else {
            // Already encoded that far: the player seeks inside the current stream.
            const t1 = performance.now();
            await seekNative(video, target - session.generationStart);
            const at = session.generationStart + video.currentTime;
            result.seek = `native → ${at.toFixed(1)} s in ${Math.round(performance.now() - t1)} ms`;
            if (Math.abs(at - target) > 12) throw new Error(`Native seek landed at ${at.toFixed(1)} s`);
          }
          // Playback must continue after the seek (audio + video present at the new position).
          const t2 = video.currentTime;
          await new Promise((r) => window.setTimeout(r, 1500));
          if (video.currentTime <= t2 || video.paused) throw new Error("Playback did not continue after the far seek");
        } else {
          const t1 = performance.now();
          video.currentTime = target;
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("Seek timed out")), 15000);
            video.addEventListener("seeked", () => { window.clearTimeout(timer); resolve(); }, { once: true });
          });
          result.seek = `range seek to ${video.currentTime.toFixed(1)} s in ${Math.round(performance.now() - t1)} ms`;
        }
      }
      return result;
    } catch (err) {
      return { name: sample.name, ok: false, mode: session?.modeLabel, pipeline: session?.decision.pipeline, error: err instanceof Error ? err.message : String(err) };
    } finally {
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
      if (session) await fetch(`/api/playback/${session.id}`, { method: "DELETE" }).catch(() => undefined);
      setRunning(null);
    }
  }, []);

  const run = useCallback(async (list: Sample[]) => {
    const out: Record<string, Result> = {};
    for (const s of list) {
      const r = await runOne(s);
      out[s.name] = r;
      setResults((prev) => ({ ...prev, [s.name]: r }));
    }
    (window as unknown as { __selfTestResults?: Record<string, Result> }).__selfTestResults = out;
    return out;
  }, [runOne]);

  const [playerFor, setPlayerFor] = useState<{ session: EngineSessionView; title: string } | null>(null);

  const openInPlayer = useCallback(async (name: string) => {
    const res = await fetch("/api/playback/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, client: detectClientCapabilities() }),
    });
    const data = await res.json();
    if (data.ok) setPlayerFor({ session: data.session as EngineSessionView, title: name });
    return data.ok as boolean;
  }, []);

  useEffect(() => {
    const w = window as unknown as {
      __runSelfTest?: () => Promise<unknown>;
      __runSample?: (name: string) => Promise<unknown>;
      __openPlayer?: (name: string) => Promise<boolean>;
    };
    w.__runSelfTest = () => run(samples);
    w.__runSample = (name: string) => run(samples.filter((s) => s.name === name));
    w.__openPlayer = openInPlayer;
  }, [run, samples, openInPlayer]);

  const passed = Object.values(results).filter((r) => r.ok).length;

  return (
    <div className="min-h-screen bg-netflix-black px-4 py-8 md:px-12">
      <Link href="/settings" className="mb-6 inline-flex items-center gap-2 text-sm hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to Settings
      </Link>
      <h1 className="mb-2 text-3xl font-semibold">Playback self-test</h1>
      <p className="mb-4 max-w-3xl text-sm text-netflix-light-gray">
        Plays generated sample files through the same path as real titles (browser → Notflix → media engine) and checks
        that this browser actually decodes the result. Generate samples with <code className="text-white">node scripts/generate-test-media.mjs</code>.
      </p>
      {caps && (
        <p className="mb-4 text-xs text-netflix-gray" data-testid="client-caps">
          This browser decodes video: {caps.mseVideo.join(", ") || "none"} · 10-bit: {caps.tenBit.join(", ") || "none"} · audio: {caps.mseAudio.join(", ")}
        </p>
      )}
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void run(samples)}
          disabled={!!running || samples.length === 0}
          className="rounded bg-netflix-red px-5 py-2 text-sm font-semibold hover:bg-netflix-red-hover disabled:opacity-50"
          data-testid="run-all"
        >
          {running ? `Running ${running}…` : "Run all"}
        </button>
        {Object.keys(results).length > 0 && (
          <span className="text-sm text-netflix-light-gray" data-testid="summary">{passed}/{Object.keys(results).length} passed</span>
        )}
      </div>
      {hint && <p className="mb-4 text-sm text-yellow-300">{hint}</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div className="overflow-x-auto rounded border border-white/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/5 text-netflix-gray">
              <tr>
                <th className="p-2">Sample</th>
                <th className="p-2">Result</th>
                <th className="p-2">Mode / pipeline</th>
                <th className="p-2">Output → decoded</th>
                <th className="p-2">Startup</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => {
                const r = results[s.name];
                return (
                  <tr key={s.name} className="border-t border-white/5 align-top" data-testid={`row-${s.name}`}>
                    <td className="p-2">
                      <p className="font-mono text-white">{s.name}</p>
                      <p className="text-netflix-gray">{s.note}</p>
                    </td>
                    <td className="p-2">
                      {r ? (r.ok ? <Check className="h-4 w-4 text-green-400" /> : <X className="h-4 w-4 text-red-400" />) : running === s.name ? "…" : ""}
                      {r?.error && <p className="mt-1 max-w-[16rem] text-red-300">{r.error}</p>}
                    </td>
                    <td className={cn("p-2", !r && "text-white/30")}>
                      {r?.mode}
                      {r?.pipeline && <p className="text-netflix-gray">{r.pipeline}</p>}
                      {r?.seek && <p className="text-netflix-gray">seek: {r.seek}</p>}
                    </td>
                    <td className="p-2 font-mono">{r?.output}{r?.decoded && <p className="text-netflix-gray">→ {r.decoded}</p>}</td>
                    <td className="p-2">{r?.startupMs != null ? `${r.startupMs} ms` : ""}{r?.serverMs != null && <p className="text-netflix-gray">server {r.serverMs} ms</p>}</td>
                    <td className="p-2">
                      <button type="button" disabled={!!running} onClick={() => void runOne(s).then((res) => setResults((p) => ({ ...p, [s.name]: res })))} className="rounded p-1 hover:bg-white/10 disabled:opacity-30" aria-label={`Run ${s.name}`}>
                        <Play className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <video ref={videoRef} className="aspect-video w-full rounded bg-black" playsInline muted />
      </div>
      {playerFor && <PlayerHarness session={playerFor.session} title={playerFor.title} onClose={() => setPlayerFor(null)} />}
    </div>
  );
}
