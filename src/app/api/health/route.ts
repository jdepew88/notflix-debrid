import { NextResponse } from "next/server";

/**
 * Public liveness check (no sign-in). Deliberately reveals nothing about configuration; signed-in
 * the owner gets engine and Real-Debrid details from /api/config/*.
 */
export async function GET() {
  return NextResponse.json({ ok: true, service: "notflix" });
}
