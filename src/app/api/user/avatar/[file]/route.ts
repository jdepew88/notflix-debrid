import fs from "fs";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { avatarFilePath } from "@/lib/avatar-store";

/** Serves an uploaded avatar to the account that owns it. File names change on every upload. */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const { file } = await context.params;
  const full = avatarFilePath(userId, decodeURIComponent(file));
  if (!full) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(full)), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
