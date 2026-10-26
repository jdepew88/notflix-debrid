"use client";

import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { buildCastMediaDescriptor } from "@/lib/cast-media";
import { initCastFramework, isCastFrameworkReady } from "@/lib/cast-init";

interface UseCastOptions {
  title: string;
  src: string;
  poster?: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  currentTime?: number;
}

export function useCast({
  title,
  src,
  poster,
  videoRef,
  currentTime = 0,
}: UseCastOptions) {
  const [castReady, setCastReady] = useState(false);
  const [casting, setCasting] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    initCastFramework().then((ready) => {
      if (!cancelled) setCastReady(ready);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isCastFrameworkReady()) return;
    const context = window.cast!.framework.CastContext.getInstance();
    const listener = () => {
      setCasting(!!context.getCurrentSession());
    };
    context.addEventListener(
      window.cast!.framework.CastContextEventType.SESSION_STATE_CHANGED,
      listener
    );
    return () => {
      context.removeEventListener(
        window.cast!.framework.CastContextEventType.SESSION_STATE_CHANGED,
        listener
      );
    };
  }, [castReady]);

  const startCast = useCallback(async () => {
    setCastError(null);
    const ready = castReady || (await initCastFramework());
    if (!ready || !window.cast?.framework) {
      setCastError("Chromecast is not available in this browser.");
      return;
    }

    const context = window.cast.framework.CastContext.getInstance();

    try {
      let session = context.getCurrentSession();
      if (!session) {
        await context.requestSession();
        session = context.getCurrentSession();
      }
      if (!session) {
        setCastError("No Chromecast device selected.");
        return;
      }

      const media = buildCastMediaDescriptor(src);

      const mediaInfo = new window.chrome.cast.media.MediaInfo(
        media.url,
        media.contentType
      );
      mediaInfo.streamType = window.chrome.cast.media.StreamType.BUFFERED;
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
      mediaInfo.metadata.title = title;
      if (poster) {
        mediaInfo.metadata.images = [{ url: poster.startsWith("http") ? poster : `${window.location.origin}${poster}` }];
      }

      const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
      if (currentTime > 0) {
        request.currentTime = currentTime;
      }

      await session.loadMedia(request);
      videoRef.current?.pause();
      setCasting(true);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not connect to Chromecast. Check that a device is on the same network.";
      setCastError(message);
      console.error("Cast failed:", err);
    }
  }, [
    castReady,
    src,
    title,
    poster,
    videoRef,
    currentTime,
  ]);

  const stopCast = useCallback(() => {
    if (!window.cast?.framework) return;
    const context = window.cast.framework.CastContext.getInstance();
    context.endCurrentSession(true);
    setCasting(false);
    setCastError(null);
  }, []);

  return { castReady, casting, castError, startCast, stopCast, clearCastError: () => setCastError(null) };
}
