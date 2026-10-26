import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

// Self-hosted at build time by next/font (no request to Google at runtime).
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: { default: "Notflix", template: "%s · Notflix" },
  description: "Your films and series, played your way — streaming with full control over sources, formats and languages.",
  applicationName: "Notflix",
  // Favicon, Apple icon and social image come from src/app/icon.svg, apple-icon.png and opengraph-image.png.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#141414",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${inter.variable}`}>
      <head>
        <script
          async
          defer
          src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
        />
      </head>
      <body className="min-h-full bg-canvas text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
