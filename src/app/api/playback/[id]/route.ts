import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { engineFetch } from "@/lib/media-engine/client";
import { forgetSession, getOwnedSession } from "@/lib/media-engine/registry";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Stops a playback session: kills its FFmpeg process and deletes its temporary files. */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const userId = await getSessionUserId();
  const session = userId ? getOwnedSession(id, userId) : null;
  if (!session) return new NextResponse(null, { status: 204 });
  forgetSession(id);
  await engineFetch(`/sessions/${id}`, {
    method: "DELETE",
    session: { token: session.token, owner: session.owner },
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return new NextResponse(null, { status: 204 });
}

/** navigator.sendBeacon can only POST; treat POST ?action=stop as DELETE when the tab closes. */
export async function POST(request: Request, ctx: Params) {
  if (new URL(request.url).searchParams.get("action") === "stop") return DELETE(request, ctx);
  return NextResponse.json({ error: "Unsupported" }, { status: 400 });
}
