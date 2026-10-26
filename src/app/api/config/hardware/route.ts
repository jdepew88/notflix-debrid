import { NextRequest, NextResponse } from "next/server";
import { requireConfigAccess } from "@/lib/config-access";
import { dataDir, updateConfig } from "@/lib/install/runtime";
import { HARDWARE_ACCELERATION_VALUES, readEngineConfig, updateEngineConfig } from "@/lib/install/config.mjs";
import { engineStatus } from "@/lib/install/status";
import { pushEngineRuntimeConfig } from "@/lib/media-engine/client";

export const dynamic = "force-dynamic";

/** Same rule as the engine: an adapter index for the chosen backend, or a Linux render node. */
const DEVICE_RE = /^(\d{1,2}|\/dev\/dri\/(renderD|card)\d{1,4})$/;

function settingsView() {
  const e = readEngineConfig(dataDir());
  return {
    hardwareAcceleration: e.hardwareAcceleration,
    hardwareDevice: e.hardwareDevice,
    maxConcurrentTranscodes: e.maxConcurrentVideoTranscodes,
    maxTranscodeHeight: e.maxTranscodeHeight,
  };
}

/**
 * Hardware acceleration: what the engine detected and verified on this machine (real test
 * encodes/decodes), and the owner's choice. `?refresh=1` re-runs detection.
 */
export async function GET(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  const engine = await engineStatus(refresh);
  if (refresh || engine.capabilities) {
    updateConfig((cfg) => {
      cfg.hardware.checkedAt = new Date().toISOString();
    });
  }
  return NextResponse.json({ engine, settings: settingsView() });
}

export async function PUT(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof updateEngineConfig>[1] = {};
  if (body.hardwareAcceleration !== undefined) {
    if (!HARDWARE_ACCELERATION_VALUES.includes(body.hardwareAcceleration as never)) {
      return NextResponse.json({ error: "Unknown acceleration option." }, { status: 400 });
    }
    patch.hardwareAcceleration = body.hardwareAcceleration as string;
  }
  if (body.hardwareDevice !== undefined) {
    if (body.hardwareDevice !== null && (typeof body.hardwareDevice !== "string" || !DEVICE_RE.test(body.hardwareDevice))) {
      return NextResponse.json({ error: "Invalid device." }, { status: 400 });
    }
    patch.hardwareDevice = (body.hardwareDevice as string | null) || null;
  }
  if (body.maxConcurrentTranscodes !== undefined) {
    const n = Number(body.maxConcurrentTranscodes);
    if (!Number.isInteger(n) || n < 1 || n > 8) return NextResponse.json({ error: "Choose 1–8 simultaneous conversions." }, { status: 400 });
    patch.maxConcurrentVideoTranscodes = n;
  }
  const saved = updateEngineConfig(dataDir(), patch);
  const engineUpdated = await pushEngineRuntimeConfig({
    hardwareAcceleration: saved.hardwareAcceleration,
    hardwareDevice: saved.hardwareDevice,
    maxConcurrentVideoTranscodes: saved.maxConcurrentVideoTranscodes,
  });
  updateConfig((cfg) => {
    if (!cfg.setup.stepsDone.includes("hardware")) cfg.setup.stepsDone.push("hardware");
  });
  return NextResponse.json({ engine: await engineStatus(), settings: settingsView(), engineUpdated });
}
