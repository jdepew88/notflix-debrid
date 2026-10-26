import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Same format as src/lib/session.ts: userId.exp.hmacHex. Needs the test server's data folder
 * (E2E_DATA_PATH), where the per-installation session key lives.
 */
export function forgeSessionToken(userId: string): string {
  const data = process.env.E2E_DATA_PATH;
  if (!data) throw new Error("E2E_DATA_PATH is required to forge session tokens");
  const secret = JSON.parse(fs.readFileSync(path.join(data, "secrets", "secrets.json"), "utf8")).sessionSecret as string;
  const payload = `${userId}.${Date.now() + 3_600_000}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export async function createAccount(request: APIRequestContext, name: string, password: string) {
  const res = await request.post("/api/auth/signup", { data: { name, password } });
  if (!res.ok()) throw new Error(`signup failed: ${res.status()}`);
}

/** Fills and submits the real login form (no profile choice). */
export async function submitLogin(page: Page, name: string, password: string, opts: { remember?: boolean } = {}) {
  await page.goto("/");
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  if (opts.remember === false) await page.getByLabel("Remember me").uncheck();
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

/** Signs in through the real login form and picks a profile (default: "Main"). */
export async function signInThroughUi(page: Page, name: string, password: string, profile = "Main") {
  await submitLogin(page, name, password);
  await page.waitForURL(/\/profiles/);
  await page.locator(`[data-testid=profile-tile][data-profile-name="${profile}"]`).click();
  await page.waitForURL(/\/browse/);
}

/** The account's profiles as the server reports them (ids, names, flags). */
export async function profilesOf(page: Page): Promise<Array<{ id: string; name: string; isKids?: boolean; hasPin?: boolean; avatar: string }>> {
  const me = await (await page.request.get("/api/auth/me")).json();
  return me.state.profiles;
}
