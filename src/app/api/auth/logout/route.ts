import { NextRequest, NextResponse } from "next/server";
import { clearedProfileCookie, clearedSessionCookie } from "@/lib/session";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.set(clearedSessionCookie(request));
  response.cookies.set(clearedProfileCookie(request));
  return response;
}
