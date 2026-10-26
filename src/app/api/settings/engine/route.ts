import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/config-access";
import { engineConfigured } from "@/lib/media-engine/client";
import { engineStatus } from "@/lib/install/status";

export const dynamic = "force-dynamic";

/** Media engine status for Settings: reachability, verified hardware/codec capabilities, load. */
export async function GET(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const status = await engineStatus(refresh);
  if (!status.online) {
    return NextResponse.json({
      ...status,
      configured: engineConfigured(),
      hint: "Start Notflix with the launcher (Start-Notflix.cmd or scripts\\notflix.ps1 start); it starts the media engine too.",
    });
  }
  return NextResponse.json({ ...status, configured: true });
}
