import { NextResponse } from "next/server";
import { getTrendingToday } from "@/lib/tmdb";
import { mergeSettings } from "@/lib/settings";

export const revalidate = 3600;

/**
 * Public (pre-sign-in) artwork for the login page: a handful of trending backdrop image paths from
 * TMDB. Only public image paths are returned; nothing account-specific, and no API key.
 */
export async function GET() {
  const apiKey = mergeSettings().tmdbApiKey?.trim();
  if (!apiKey) return NextResponse.json({ backdrops: [] });
  try {
    const items = await getTrendingToday(apiKey, 1);
    const backdrops = items
      .filter((i) => i.backdropPath && (i.rating ?? 0) >= 6.5)
      .slice(0, 8)
      .map((i) => ({ path: i.backdropPath, title: i.title }));
    return NextResponse.json({ backdrops }, { headers: { "Cache-Control": "public, max-age=3600" } });
  } catch {
    return NextResponse.json({ backdrops: [] });
  }
}
