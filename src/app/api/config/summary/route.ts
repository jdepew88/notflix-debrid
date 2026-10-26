import { NextRequest, NextResponse } from "next/server";
import { requireConfigAccess } from "@/lib/config-access";
import { installSummary } from "@/lib/install/status";

export const dynamic = "force-dynamic";

/** Non-secret overview of the installation (setup summary, Settings → System). Owner only. */
export async function GET(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  return NextResponse.json(await installSummary({ refreshEngine: request.nextUrl.searchParams.get("refresh") === "1" }));
}
