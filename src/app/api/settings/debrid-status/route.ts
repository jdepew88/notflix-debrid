import { NextResponse } from "next/server";
import { debridProvider, type DebridAccountStatus } from "@/lib/debrid";
import { secrets } from "@/lib/install/runtime";

export const dynamic = "force-dynamic";

let cached: { at: number; value: DebridAccountStatus; key: string } | null = null;

/** Real-Debrid account status (validated server-side; the token is never returned). */
export async function GET(request: Request) {
  const token = secrets().realDebridToken;
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const key = token.slice(-8);
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < 60_000) {
    return NextResponse.json(cached.value);
  }
  const value = await debridProvider().checkAccount();
  cached = { at: Date.now(), value, key };
  return NextResponse.json(value);
}
