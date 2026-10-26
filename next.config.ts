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
  images: {
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
