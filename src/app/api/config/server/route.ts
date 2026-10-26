import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { requireConfigAccess } from "@/lib/config-access";
import { dataDir, serverConfig, updateConfig } from "@/lib/install/runtime";
import { MAX_CACHE_GIB, MIN_CACHE_GIB, bindAddressFor, readEngineConfig, updateEngineConfig, validHostname, validPort, validPublicUrl } from "@/lib/install/config.mjs";
import { cacheDirProblem } from "@/lib/install/paths.mjs";
import { advertiseStatus, lanAddresses, listenStatus } from "@/lib/install/status";
import { MAX_SERVER_NAME, cleanServerName, serverName } from "@/lib/install/identity.mjs";
import { pushEngineRuntimeConfig } from "@/lib/media-engine/client";

export const dynamic = "force-dynamic";

function view() {
  const cfg = serverConfig();
  const engine = readEngineConfig(dataDir());
  return {
    server: { ...cfg.server, effectiveBindAddress: bindAddressFor(cfg), effectiveName: serverName(cfg) },
    storage: { ...cfg.storage, dataDir: dataDir() },
    engine: { port: engine.port },
    listening: listenStatus(),
    advertisement: advertiseStatus(),
    lanAddresses: lanAddresses(),
    stepsDone: cfg.setup.stepsDone,
  };
}

/** Server address, network exposure and storage. Setup-code holder (before an owner) or owner. */
export async function GET(request: NextRequest) {
  const access = await requireConfigAccess(request, { allowBeforeOwner: true });
  if (access instanceof NextResponse) return access;
  return NextResponse.json(view());
}

function checkWritable(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.notflix-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return null;
  } catch (err) {
    return `Notflix cannot write to that folder (${err instanceof Error ? err.message : "access denied"}).`;
  }
}

export async function PUT(request: NextRequest) {
  const access = await requireConfigAccess(request, { allowBeforeOwner: true });
  if (access instanceof NextResponse) return access;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const current = serverConfig();

  const port = body.port === undefined ? current.server.port : Number(body.port);
  if (!validPort(port)) errors.port = "Use a port between 1024 and 65535.";
  const enginePort = readEngineConfig(dataDir()).port;
  if (port === enginePort) errors.port = `Port ${enginePort} is used by the media engine.`;

  const hostname = body.hostname === undefined ? current.server.hostname : String(body.hostname ?? "").trim();
  if (hostname && !validHostname(hostname)) errors.hostname = "Enter a host name (e.g. media-pc.local) or an IP address, without http:// or a port.";

  const publicUrl = body.publicUrl === undefined ? current.server.publicUrl : String(body.publicUrl ?? "").trim();
  if (publicUrl && !validPublicUrl(publicUrl)) errors.publicUrl = "Enter a full address such as https://notflix.example.com (no path or query).";

  const name = body.name === undefined ? current.server.name : String(body.name ?? "").trim();
  if (name && (cleanServerName(name) !== name || name.length > MAX_SERVER_NAME)) {
    errors.name = `Use up to ${MAX_SERVER_NAME} letters, digits, spaces or symbols, without dots.`;
  }

  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const allowLan = bool(body.allowLan, current.server.allowLan);
  const advertise = bool(body.advertise, current.server.advertise);
  const reverseProxy = bool(body.reverseProxy, current.server.reverseProxy);

  const cacheDirectory = body.cacheDirectory === undefined ? current.storage.cacheDirectory : String(body.cacheDirectory ?? "").trim();
  const cacheProblem = cacheDirProblem(cacheDirectory, { dataDir: dataDir() }) ?? (cacheDirectory !== current.storage.cacheDirectory ? checkWritable(cacheDirectory) : null);
  if (cacheProblem) errors.cacheDirectory = cacheProblem;
  const cacheMaxGiB = body.cacheMaxGiB === undefined ? current.storage.cacheMaxGiB : Number(body.cacheMaxGiB);
  if (!Number.isFinite(cacheMaxGiB) || cacheMaxGiB < MIN_CACHE_GIB || cacheMaxGiB > MAX_CACHE_GIB) {
    errors.cacheMaxGiB = `Choose between ${MIN_CACHE_GIB} and ${MAX_CACHE_GIB} GB.`;
  }

  if (Object.keys(errors).length) return NextResponse.json({ error: "Please fix the highlighted fields.", errors }, { status: 400 });

  const cacheMoved = path.resolve(cacheDirectory) !== path.resolve(current.storage.cacheDirectory);
  const listenChanged = port !== current.server.port || allowLan !== current.server.allowLan;
  updateConfig((cfg) => {
    cfg.server.port = port;
    cfg.server.hostname = hostname;
    cfg.server.publicUrl = publicUrl;
    cfg.server.allowLan = allowLan;
    cfg.server.reverseProxy = reverseProxy;
    cfg.server.name = name;
    cfg.server.advertise = advertise;
    cfg.storage.cacheDirectory = path.resolve(cacheDirectory);
    cfg.storage.cacheMaxGiB = Math.round(cacheMaxGiB);
    if (!cfg.setup.stepsDone.includes("server")) cfg.setup.stepsDone.push("server");
  });
  // The engine reads storage from its own config file; the size limit also applies immediately.
  const engine = updateEngineConfig(dataDir(), {});
  const engineUpdated = await pushEngineRuntimeConfig({ cacheMaxBytes: engine.cacheMaxBytes });

  return NextResponse.json({
    ...view(),
    applied: {
      // server.mjs watches the config file and moves to the new address on its own.
      listenChanged,
      engineUpdated,
      restartRequired: cacheMoved ? ["The media engine uses the new cache folder after Notflix restarts."] : [],
    },
  });
}
