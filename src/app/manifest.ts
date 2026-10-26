import type { MetadataRoute } from "next";

/** Installable web app manifest (also the basis for a future TV/Android wrapper). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Notflix",
    short_name: "Notflix",
    description: "Your films and series, played your way.",
    start_url: "/browse",
    display: "standalone",
    background_color: "#141414",
    theme_color: "#141414",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/brand/notflix-icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
