import { NextRequest, NextResponse } from "next/server";
import { requireConfigAccess } from "@/lib/config-access";
import { saveSecrets, secrets, serverConfig, updateConfig } from "@/lib/install/runtime";
import { secretHint } from "@/lib/install/secrets.mjs";
import { validateTmdbCredential } from "@/lib/tmdb";

export const dynamic = "force-dynamic";

function view() {
  const key = secrets().tmdbApiKey;
  return {
    tmdb: {
      required: true,
      configured: Boolean(key),
      hint: secretHint(key),
      validatedAt: serverConfig().metadata.tmdbValidatedAt,
    },
  };
}

/**
 * Metadata providers. This edition uses TMDB only (catalog, details, artwork, episodes, ratings);
 * nothing else needs a key. Owner only; credentials are never returned.
 */
export async function GET(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  return NextResponse.json(view());
}

/** Validate a credential without saving it (`{ tmdbApiKey }`), or re-check the stored one. */
export async function POST(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  const body = await request.json().catch(() => ({}));
  const candidate = typeof body.tmdbApiKey === "string" && body.tmdbApiKey.trim() ? body.tmdbApiKey : secrets().tmdbApiKey;
  const result = await validateTmdbCredential(candidate);
  if (result.ok && candidate === secrets().tmdbApiKey) {
    updateConfig((cfg) => {
      cfg.metadata.tmdbValidatedAt = new Date().toISOString();
    });
  }
  return NextResponse.json({ result, ...view() });
}

/** Saves a TMDB credential after it validates. A rejected credential is never stored. */
export async function PUT(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  const body = await request.json().catch(() => ({}));
  const key = typeof body.tmdbApiKey === "string" ? body.tmdbApiKey.trim() : "";
  const result = await validateTmdbCredential(key);
  if (!result.ok) return NextResponse.json({ error: result.message, result, ...view() }, { status: result.status === "unreachable" ? 502 : 400 });
  saveSecrets({ tmdbApiKey: key });
  updateConfig((cfg) => {
    cfg.metadata.tmdbValidatedAt = new Date().toISOString();
    if (!cfg.setup.stepsDone.includes("metadata")) cfg.setup.stepsDone.push("metadata");
  });
  return NextResponse.json({ result, ...view() });
}

export async function DELETE(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  saveSecrets({ tmdbApiKey: "" });
  updateConfig((cfg) => {
    cfg.metadata.tmdbValidatedAt = null;
  });
  return NextResponse.json(view());
}
