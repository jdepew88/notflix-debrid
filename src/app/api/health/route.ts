import { NextResponse } from "next/server";
import { dataDir, serverConfig } from "@/lib/install/runtime";
import { API_VERSION, instanceId, serverName } from "@/lib/install/identity.mjs";
import { advertiseStatus } from "@/lib/install/status";

export const dynamic = "force-dynamic";

/**
 * Public liveness and identity check (no sign-in), used by apps to recognise a Notflix server
 * before sending anything else. Reveals only what the LAN advertisement already announces: the
 * friendly name, the random instance ID and the API version. Never credentials, accounts, paths or
 * settings; signed-in, the owner gets engine and Real-Debrid details from /api/config/*.
 * The name is the one announced on the network, which may carry a " (2)" suffix when another
 * server already uses the configured name, so apps can tell the two apart.
 */
export async function GET() {
  const announced = advertiseStatus();
  return NextResponse.json({
    ok: true,
    service: "notflix",
    name: announced?.active && announced.name ? announced.name : serverName(serverConfig()),
    instanceId: instanceId(dataDir()),
    apiVersion: API_VERSION,
    auth: ["password"],
  });
}
