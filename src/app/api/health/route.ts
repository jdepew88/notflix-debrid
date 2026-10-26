import { NextResponse } from "next/server";

/**
 * Public liveness check (no sign-in). Deliberately reveals nothing about configuration; signed-in
 * users get engine/Real-Debrid details from /api/settings/engine and /api/settings/debrid-status.
 */
export async function GET() {
  return NextResponse.json({ ok: true, service: "notflix" });
}
