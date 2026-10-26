import { expect, test } from "@playwright/test";
import { createAccount, forgeSessionToken, signInThroughUi, submitLogin, uniqueName } from "./helpers";

test("a brand-new account signs up and reaches the movie browser", async ({ page }) => {
  const name = uniqueName("e2e-new");
  await page.goto("/signup");
  // Client-side validation before anything is sent.
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password").fill("different");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
  await expect(page.getByText("Passwords don't match.")).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill("e2e-pass-1");
  await page.getByLabel("Confirm password").fill("e2e-pass-1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL(/\/profiles$/);
  await expect(page.getByRole("heading", { name: /Who.s watching\?/ })).toBeVisible();
  await page.locator("[data-testid=profile-tile][data-profile-name=Main]").click();

  await page.waitForURL(/\/browse/);
  // Real catalog rows (TMDB).
  await expect(page.getByText(/Trending Today|Trending This Week|Popular Movies/).first()).toBeVisible({ timeout: 45_000 });
  // Reload keeps the user on /browse (session + profile survive a full page load).
  await page.reload();
  await expect(page).toHaveURL(/\/browse/);
  await expect(page.getByText(/Trending Today|Trending This Week|Popular Movies/).first()).toBeVisible({ timeout: 45_000 });

  // No credentials are stored in the browser.
  const stored = await page.evaluate(() => localStorage.getItem("notflix-storage") ?? "");
  const settings = JSON.parse(stored || "{}").state?.settings ?? {};
  expect(settings.realDebridToken ?? "").toBe("");
  expect(settings.tmdbApiKey ?? "").toBe("");
});

test("sign-in form: generic errors, show/hide password, remember me, sign out", async ({ page, request, context }) => {
  const name = uniqueName("e2e-login");
  await createAccount(request, name, "e2e-pass-2");

  // A wrong password and an unknown account produce the same message.
  await submitLogin(page, name, "wrong-password");
  await expect(page.getByTestId("auth-error")).toHaveText("Incorrect username or password.");
  await submitLogin(page, `${name}-nobody`, "wrong-password");
  await expect(page.getByTestId("auth-error")).toHaveText("Incorrect username or password.");

  // Show/hide password.
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("secret-text");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");

  // Without "Remember me" the session cookie lives only for the browser session.
  await submitLogin(page, name, "e2e-pass-2", { remember: false });
  await page.waitForURL(/\/profiles/);
  const short = (await context.cookies()).find((c) => c.name === "notflix_session")!;
  expect(short.expires).toBe(-1);
  // With it, the cookie persists for ~30 days.
  await context.clearCookies();
  await submitLogin(page, name, "e2e-pass-2");
  await page.waitForURL(/\/profiles/);
  const long = (await context.cookies()).find((c) => c.name === "notflix_session")!;
  expect(long.expires * 1000 - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
  expect(long.httpOnly).toBe(true);
  expect(long.sameSite).toBe("Lax");

  // Sign out from the profile menu clears both cookies and protects the app again.
  await page.locator("[data-testid=profile-tile][data-profile-name=Main]").click();
  await page.waitForURL(/\/browse/);
  await page.getByTestId("profile-menu-button").click();
  await page.getByTestId("menu-sign-out").click();
  await page.waitForURL((u) => u.pathname === "/");
  const after = await context.cookies();
  expect(after.find((c) => c.name === "notflix_session")?.value ?? "").toBe("");
  expect(after.find((c) => c.name === "notflix_profile")?.value ?? "").toBe("");
  await page.goto("/browse");
  await expect(page).toHaveURL(/\/\?next=%2Fbrowse/);
});

test("repeated wrong passwords are rate limited", async ({ request }) => {
  const name = uniqueName("e2e-limit");
  await createAccount(request, name, "e2e-pass-4");
  for (let i = 0; i < 5; i++) {
    const res = await request.post("/api/auth/login", { data: { name, password: `nope-${i}` } });
    expect(res.status()).toBe(401);
  }
  const blocked = await request.post("/api/auth/login", { data: { name, password: "e2e-pass-4" } });
  expect(blocked.status()).toBe(429);
  expect(Number(blocked.headers()["retry-after"])).toBeGreaterThan(0);
  expect((await blocked.json()).error).toMatch(/Too many sign-in attempts/);
});

test("changing the password signs out other browsers", async ({ browser, baseURL }) => {
  const name = uniqueName("e2e-pw");
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  await a.request.post("/api/auth/signup", { data: { name, password: "e2e-pass-5" } });
  await b.request.post("/api/auth/login", { data: { name, password: "e2e-pass-5" } });
  expect((await b.request.get("/api/auth/me")).status()).toBe(200);
  const changed = await a.request.post("/api/auth/password", { data: { current: "e2e-pass-5", next: "e2e-pass-6x" } });
  expect(changed.status()).toBe(200);
  expect((await a.request.get("/api/auth/me")).status()).toBe(200); // this browser stays signed in
  expect((await b.request.get("/api/auth/me")).status()).toBe(401); // the other one is signed out
  expect((await a.request.post("/api/auth/login", { data: { name, password: "e2e-pass-6x" } })).status()).toBe(200);
  await a.close();
  await b.close();
});

test("a session cookie from before session versions still works for an existing account", async ({ page, request, context, baseURL }) => {
  const name = uniqueName("e2e-legacy");
  await createAccount(request, name, "e2e-pass-7");
  const me = await (await request.get("/api/auth/me")).json();
  const url = new URL(baseURL!);
  await context.addCookies([{ name: "notflix_session", value: forgeSessionToken(me.user.id), domain: url.hostname, path: "/" }]);
  await page.goto("/profiles");
  await expect(page.locator("[data-testid=profile-tile][data-profile-name=Main]")).toBeVisible();
});

test("a stale session cookie for a missing account does not loop", async ({ page, context, baseURL }) => {
  const url = new URL(baseURL!);
  await context.addCookies([{ name: "notflix_session", value: forgeSessionToken("00000000-dead-beef-0000-000000000000"), domain: url.hostname, path: "/" }]);
  const responses: string[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "document") responses.push(r.url());
  });
  await page.goto("/");
  // Proxy sends the browser to /profiles, /api/auth/me clears the cookie, and the login form shows.
  await expect(page.getByLabel("Username")).toBeVisible({ timeout: 20_000 });
  expect(responses.length).toBeLessThan(6);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "notflix_session")?.value ?? "").toBe("");
});

test("protected pages redirect to sign-in, then profiles, then back", async ({ page, request }) => {
  const name = uniqueName("e2e-next");
  await createAccount(request, name, "e2e-pass-3");
  await page.context().clearCookies();
  await page.goto("/browse/my-list");
  await expect(page).toHaveURL(/\/\?next=%2Fbrowse%2Fmy-list/);
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password", { exact: true }).fill("e2e-pass-3");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/profiles\?next=/);
  await page.locator("[data-testid=profile-tile][data-profile-name=Main]").click();
  await page.waitForURL(/\/browse\/my-list/);
  await expect(page.getByRole("heading", { name: "My List" })).toBeVisible();
});

test("an existing account signs in through the form and reaches browse", async ({ page, request }) => {
  const name = uniqueName("e2e-existing");
  await createAccount(request, name, "e2e-pass-2");
  await signInThroughUi(page, name, "e2e-pass-2");
  await expect(page).toHaveURL(/\/browse/);
});
