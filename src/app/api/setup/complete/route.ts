import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/config-access";
import { serverConfig, updateConfig } from "@/lib/install/runtime";
import { engineStatus, installSummary, requirements } from "@/lib/install/status";

export const dynamic = "force-dynamic";

/** Final step: marks setup complete only when every critical requirement is met. */
export async function POST(_request: NextRequest) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  if (serverConfig().setup.completed) {
    return NextResponse.json({ error: "Setup is already complete. Use Settings to change things.", code: "setup_done" }, { status: 409 });
  }
  const missing = requirements(await engineStatus()).filter((r) => !r.ok);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: "Some required settings are not ready yet.", code: "requirements_missing", missing },
      { status: 409 }
    );
  }
  updateConfig((cfg) => {
    cfg.setup.completed = true;
    cfg.setup.completedAt = new Date().toISOString();
  });
  return NextResponse.json({ ok: true, summary: await installSummary() });
}
