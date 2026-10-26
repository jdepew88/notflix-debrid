"use client";

let initPromise: Promise<boolean> | null = null;
let initialized = false;

export function initCastFramework(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (initialized && window.cast?.framework) return Promise.resolve(true);
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve) => {
    const tryInit = () => {
      if (!window.cast?.framework) return false;
      if (!initialized) {
        const context = window.cast.framework.CastContext.getInstance();
        context.setOptions({
          receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });
        initialized = true;
      }
      resolve(true);
      return true;
    };

    window.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (isAvailable && tryInit()) return;
      if (!isAvailable) resolve(false);
    };

    if (tryInit()) return;

    const interval = setInterval(() => {
      if (tryInit()) clearInterval(interval);
    }, 500);

    setTimeout(() => {
      clearInterval(interval);
      if (!initialized) resolve(false);
    }, 15000);
  });

  return initPromise;
}

export function isCastFrameworkReady(): boolean {
  return initialized && !!window.cast?.framework;
}

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
  }
}
