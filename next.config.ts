import os from "os";
import { execSync } from "child_process";
import type { NextConfig } from "next";
import pkg from "./package.json";

/** Short commit of the build (shown in the footer); empty outside a git checkout. */
function buildCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/** Development only: allow the dev server to be opened from this machine's own addresses. */
function devOrigins(): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1"]);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4") hosts.add(net.address);
    }
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_COMMIT: buildCommit(),
  },
  allowedDevOrigins: devOrigins(),
  // The data cache stays in memory (bounded by cacheMaxMemorySize). On disk it would keep request
  // URLs, and TMDB v3 keys travel as a query parameter, so the key would land in clear text in
  // .next/cache/fetch-cache, outside the encrypted credential store.
  cacheMaxMemorySize: 64 * 1024 * 1024,
  experimental: {
    isrFlushToDisk: false,
  },
  // The notification service worker must never be served stale (browsers check it for updates).
  async headers() {
    return [
      {
        source: "/notflix-sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; img-src 'self' https://image.tmdb.org" },
        ],
      },
    ];
  },
  images: {
    // Optimized TMDB artwork is disposable; cap it instead of Next's default of half the free disk.
    maximumDiskCacheSize: 512 * 1024 * 1024,
    // TMDB artwork paths are content-addressed (a new image gets a new path), so cache optimized copies for 31 days.
    minimumCacheTTL: 2678400,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },
};

export default nextConfig;
