import { NextRequest, NextResponse } from "next/server";
import { requireConfigAccess } from "@/lib/config-access";
import { saveSecrets, secrets, serverConfig, updateConfig } from "@/lib/install/runtime";
import { secretHint } from "@/lib/install/secrets.mjs";
import { debridProvider } from "@/lib/debrid";
import { validPublicUrl } from "@/lib/install/config.mjs";

export const dynamic = "force-dynamic";

function view() {
  const provider = debridProvider();
  const cfg = serverConfig();
  const s = secrets();
  return {
    provider: {
      id: provider.id,
      name: provider.displayName,
      credentialLabel: provider.credentialLabel,
      credentialHelpUrl: provider.credentialHelpUrl,
    },
    configured: Boolean(s.realDebridToken),
    hint: secretHint(s.realDebridToken),
    validatedAt: cfg.debrid.validatedAt,
    account: cfg.debrid.account,
    sources: cfg.debrid.sources,
    customSourceConfigured: Boolean(s.customSourceUrl),
    sourceChoices: provider.sourceAddonChoices,
  };
}

/** Debrid account + release-search sources. Owner only; the token is never returned. */
export async function GET(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  return NextResponse.json(view());
}

/** Checks a token without saving (`{ token }`), or the stored one. */
export async function POST(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  const body = await request.json().catch(() => ({}));
  const candidate = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
  const status = await debridProvider().checkAccount(candidate);
  if (!candidate && status.status === "active") {
    updateConfig((cfg) => {
      cfg.debrid.validatedAt = new Date().toISOString();
      cfg.debrid.account = status.username ?? null;
    });
  }
  return NextResponse.json({ status, ...view() });
}

/**
 * Saves the account token (validated first; a rejected token is never stored) and/or the
 * release-search source selection.
 */
export async function PUT(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const provider = debridProvider();
  let status = null;

  if (typeof body.token === "string" && body.token.trim()) {
    const token = body.token.trim();
    if (!/^[A-Za-z0-9]{20,128}$/.test(token)) {
      return NextResponse.json({ error: `That doesn't look like a ${provider.displayName} ${provider.credentialLabel}.`, ...view() }, { status: 400 });
    }
    status = await provider.checkAccount(token);
    if (status.status === "invalid-token") {
      return NextResponse.json({ error: status.message, status, ...view() }, { status: 400 });
    }
    if (status.status === "unreachable" || status.status === "error") {
      return NextResponse.json({ error: `${status.message} The token was not saved; try again.`, status, ...view() }, { status: 502 });
    }
    // A working token is only replaced by one that can stream too (e.g. not by an expired account).
    if (status.status !== "active" && serverConfig().debrid.validatedAt && secrets().realDebridToken && secrets().realDebridToken !== token) {
      return NextResponse.json(
        { error: `${status.message} Your current ${provider.credentialLabel} still works, so it was kept.`, status, ...view() },
        { status: 409 }
      );
    }
    saveSecrets({ realDebridToken: token });
    updateConfig((cfg) => {
      cfg.debrid.validatedAt = status!.status === "active" ? new Date().toISOString() : null;
      cfg.debrid.account = status!.username ?? null;
    });
  }

  const src = body.sources as Record<string, unknown> | undefined;
  if (src && typeof src === "object") {
    let customUrl: string | undefined;
    if (typeof body.customUrl === "string") {
      customUrl = body.customUrl.trim();
      if (customUrl && (!validPublicUrl(customUrl.replace(/\/manifest\.json$/i, "")) || !customUrl.startsWith("https://"))) {
        return NextResponse.json({ error: "Custom addon URLs must start with https://", ...view() }, { status: 400 });
      }
      saveSecrets({ customSourceUrl: customUrl });
    }
    updateConfig((cfg) => {
      for (const k of ["torrentio", "peerflix", "custom"] as const) {
        if (typeof src[k] === "boolean") cfg.debrid.sources[k] = src[k] as boolean;
      }
    });
  }

  updateConfig((cfg) => {
    if (cfg.debrid.validatedAt && !cfg.setup.stepsDone.includes("debrid")) cfg.setup.stepsDone.push("debrid");
  });
  return NextResponse.json({ status, ...view() });
}

export async function DELETE(request: NextRequest) {
  const access = await requireConfigAccess(request);
  if (access instanceof NextResponse) return access;
  saveSecrets({ realDebridToken: "" });
  updateConfig((cfg) => {
    cfg.debrid.validatedAt = null;
    cfg.debrid.account = null;
  });
  return NextResponse.json(view());
}
