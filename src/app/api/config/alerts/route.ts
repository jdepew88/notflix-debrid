import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/config-access";
import { configAlerts } from "@/lib/install/alerts";

export const dynamic = "force-dynamic";

/** Configuration problems the owner should fix (missing or rejected credentials). Owner only. */
export async function GET(request: NextRequest) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json({ alerts: await configAlerts({ fresh: request.nextUrl.searchParams.get("fresh") === "1" }) });
}
