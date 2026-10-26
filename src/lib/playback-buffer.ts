import type { HlsConfig } from "hls.js";

export type BufferTier = "sd" | "hd" | "uhd";

interface BufferProfile {
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxBufferSize: number;
  maxStarvationDelay: number;
  maxLoadingDelay: number;
  minPlayBufferSeconds: number;
  startFragPrefetch: boolean;
}

const PROFILES: Record<BufferTier, BufferProfile> = {
  sd: {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    maxBufferSize: 60 * 1000 * 1000,
    maxStarvationDelay: 4,
    maxLoadingDelay: 4,
    minPlayBufferSeconds: 8,
    startFragPrefetch: false,
  },
  hd: {
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    maxBufferSize: 120 * 1000 * 1000,
    maxStarvationDelay: 8,
    maxLoadingDelay: 8,
    minPlayBufferSeconds: 20,
    startFragPrefetch: true,
  },
  uhd: {
    maxBufferLength: 120,
    maxMaxBufferLength: 240,
    maxBufferSize: 250 * 1000 * 1000,
    maxStarvationDelay: 12,
    maxLoadingDelay: 12,
    minPlayBufferSeconds: 45,
    startFragPrefetch: true,
  },
};

export function qualityTierFromHint(hint?: string | null): BufferTier {
  if (!hint) return "hd";
  const q = hint.toLowerCase();
  if (q.includes("4k") || q.includes("2160") || q.includes("uhd")) return "uhd";
  if (q.includes("1080") || q.includes("720")) return "hd";
  if (q.includes("480") || q.includes("sd")) return "sd";
  return "hd";
}

export function qualityTierFromHeight(height: number): BufferTier {
  if (height >= 1440) return "uhd";
  if (height >= 720) return "hd";
  return "sd";
}

export function getBufferProfile(tier: BufferTier): BufferProfile {
  return PROFILES[tier];
}

export function getMinPlayBufferSeconds(tier: BufferTier): number {
  return PROFILES[tier].minPlayBufferSeconds;
}

export function buildHlsConfig(tier: BufferTier): Partial<HlsConfig> {
  const profile = PROFILES[tier];
  return {
    enableWorker: false,
    startPosition: 0,
    enableWebVTT: true,
    lowLatencyMode: false,
    // Engine playlists are EVENT playlists that grow while FFmpeg works. Without this, HLS.js leaves
    // duration at Infinity with no seekable range and the browser silently ignores every seek.
    liveDurationInfinity: true,
    maxBufferLength: profile.maxBufferLength,
    maxMaxBufferLength: profile.maxMaxBufferLength,
    maxBufferSize: profile.maxBufferSize,
    maxBufferHole: 0.5,
    backBufferLength: 30,
    maxStarvationDelay: profile.maxStarvationDelay,
    maxLoadingDelay: profile.maxLoadingDelay,
    startFragPrefetch: profile.startFragPrefetch,
  };
}

export function applyHlsBufferTier(hls: { config: Partial<HlsConfig> }, tier: BufferTier): void {
  const profile = PROFILES[tier];
  Object.assign(hls.config, {
    maxBufferLength: profile.maxBufferLength,
    maxMaxBufferLength: profile.maxMaxBufferLength,
    maxBufferSize: profile.maxBufferSize,
    maxStarvationDelay: profile.maxStarvationDelay,
    maxLoadingDelay: profile.maxLoadingDelay,
    startFragPrefetch: profile.startFragPrefetch,
  });
}

export function getBufferedAhead(video: HTMLVideoElement): number {
  const time = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);
    if (start <= time && end > time) {
      return end - time;
    }
  }
  return 0;
}

export function hasEnoughBuffer(video: HTMLVideoElement, minSeconds: number): boolean {
  return (
    getBufferedAhead(video) >= minSeconds ||
    video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
  );
}

export async function playWhenBuffered(
  video: HTMLVideoElement,
  minSeconds: number,
  timeoutMs = 60000
): Promise<void> {
  if (hasEnoughBuffer(video, minSeconds)) {
    await video.play();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      void video.play().then(resolve).catch(reject);
    }, timeoutMs);

    const check = () => {
      if (hasEnoughBuffer(video, minSeconds)) {
        cleanup();
        void video.play().then(resolve).catch(reject);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("progress", check);
      video.removeEventListener("canplaythrough", check);
      video.removeEventListener("loadeddata", check);
    };

    video.addEventListener("progress", check);
    video.addEventListener("canplaythrough", check);
    video.addEventListener("loadeddata", check);
    check();
  });
}
