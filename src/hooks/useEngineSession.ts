"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  sessionPlaybackUrl,
  type EngineSessionView,
  type EngineStatus,
} from "@/lib/playback-client";

export interface EngineSessionState {
  session: EngineSessionView;
  /** URL the <video>/HLS.js element should load for the current generation. */
  src: string;
  /** Movie time (seconds) that video.currentTime 0 corresponds to. */
  offset: number;
  /** Bumps whenever the player must reload (new generation / mode). */
  revision: number;
}

/**
 * Drives one media-engine session from the browser:
 *  - seek(): native when the target is already (or about to be) encoded, otherwise asks the
 *    engine to start a new generation at the target and swaps the source;
 *  - changeTracks(): re-plans audio/subtitle choices (may switch Direct Play ↔ Remux/Transcode);
 *  - a light status heartbeat (every 5 s) reports the viewer position so the engine can throttle
 *    and evict, and picks up server-side recovery restarts;
 *  - stops the session (kills FFmpeg, deletes temp files) when the player goes away.
 */
export function useEngineSession(initial: EngineSessionView | null) {
  const fresh = (s: EngineSessionView | null): EngineSessionState | null =>
    s ? { session: s, src: sessionPlaybackUrl(s), offset: s.generationStart, revision: 0 } : null;
  const [state, setState] = useState<EngineSessionState | null>(() => fresh(initial));
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new session from the caller replaces everything (derived-state pattern, no effect needed).
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setState(fresh(initial));
    setStatus(null);
    setError(null);
  }
  const positionRef = useRef(0);
  const stateRef = useRef(state);
  const statusRef = useRef(status);
  useEffect(() => {
    stateRef.current = state;
    statusRef.current = status;
  }, [state, status]);

  const apply = useCallback((next: EngineSessionView, force = false) => {
    setState((prev) => {
      if (!force && prev && prev.session.generation === next.generation && prev.session.mode === next.mode) {
        return { ...prev, session: next };
      }
      return { session: next, src: sessionPlaybackUrl(next), offset: next.generationStart, revision: (prev?.revision ?? 0) + 1 };
    });
  }, []);

  const reportPosition = useCallback((movieTime: number) => {
    positionRef.current = movieTime;
  }, []);

  /** Returns true when the seek was handled by restarting the stream (player should not seek). */
  const seek = useCallback(
    async (target: number): Promise<boolean> => {
      const current = stateRef.current;
      if (!current || current.session.output !== "hls") return false;
      const st = statusRef.current;
      const evicted = st?.evictedUntil ?? current.offset;
      const reachable = st ? (st.producedUntil ?? current.offset) + (st.ended ? 0 : 30) : current.offset + 30;
      if (target >= Math.max(current.offset, evicted) && target <= reachable) return false;

      setBusy(true);
      try {
        const res = await fetch(`/api/playback/${current.session.id}/seek`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: target }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Seek failed");
        if (data.native) return false;
        apply(data.session as EngineSessionView, true);
        positionRef.current = target;
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Seek failed");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply]
  );

  const changeTracks = useCallback(
    async (audioIndex: number | null, subtitleIndex: number | null): Promise<EngineSessionView | null> => {
      const current = stateRef.current;
      if (!current) return null;
      setBusy(true);
      try {
        const res = await fetch(`/api/playback/${current.session.id}/tracks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioIndex, subtitleIndex, position: positionRef.current }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not switch tracks");
        const next = data as EngineSessionView;
        const restarted = next.generation !== current.session.generation || next.mode !== current.session.mode;
        apply(next, restarted);
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not switch tracks");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [apply]
  );

  // Heartbeat / status.
  const sessionId = state?.session.id;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/playback/${sessionId}/status?position=${positionRef.current.toFixed(1)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setError("The playback session ended. Press play to start again.");
          return;
        }
        if (!res.ok) return;
        const st = (await res.json()) as EngineStatus;
        setStatus(st);
        const current = stateRef.current;
        // The engine restarted the stream on its own (recovery after a failure): reload there.
        if (current && st.generation !== current.session.generation && current.session.output === "hls") {
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  session: { ...prev.session, generation: st.generation, generationStart: st.generationStart },
                  src: `/api/playback/${sessionId}/manifest?generation=${st.generation}`,
                  offset: st.generationStart,
                  revision: prev.revision + 1,
                }
              : prev
          );
        }
      } catch {
        /* transient; next tick */
      }
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId]);

  // Stop the session when leaving (tab close uses a beacon, which survives unload).
  useEffect(() => {
    if (!sessionId) return;
    const stopBeacon = () => navigator.sendBeacon?.(`/api/playback/${sessionId}?action=stop`);
    window.addEventListener("pagehide", stopBeacon);
    return () => {
      window.removeEventListener("pagehide", stopBeacon);
      void fetch(`/api/playback/${sessionId}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
  }, [sessionId]);

  return { state, status, busy, error, seek, changeTracks, reportPosition, clearError: () => setError(null) };
}
