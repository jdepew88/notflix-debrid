import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { createAccount, profilesOf, signInThroughUi, uniqueName } from "./helpers";

const PASSWORD = "e2e-pass-8";

async function signedIn(page: Page, request: Parameters<typeof createAccount>[0], prefix = "e2e-prof") {
  const name = uniqueName(prefix);
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  return name;
}

const tile = (page: Page, name: string) => page.locator(`[data-testid=profile-tile][data-profile-name="${name}"]`);

async function manage(page: Page, name: string) {
  await page.goto("/profiles?manage=1");
  await tile(page, name).click();
  await expect(page.getByTestId("profile-editor")).toBeVisible();
}

/** 800×400 PNG: left half red, right half blue. */
const splitImage = () =>
  sharp({ create: { width: 800, height: 400, channels: 3, background: "#ff0000" } })
    .composite([{ input: { create: { width: 400, height: 400, channels: 3, background: "#0000ff" } }, left: 400, top: 0 }])
    .png()
    .toBuffer();

async function pixel(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

test("create, rename, change avatar (with Cancel), and delete a profile", async ({ page, request }) => {
  await signedIn(page, request);
  await page.goto("/profiles");
  await page.getByTestId("profile-add").click();
  const editor = page.getByTestId("profile-editor");
  await editor.getByLabel("Name").fill("Rae");
  await editor.getByRole("tab", { name: "Space exploration" }).click();
  await expect(editor.locator("[data-avatar-id]")).toHaveCount(4); // the Space exploration collection
  await editor.locator("[data-avatar-id=v2-space-launch]").click();
  await expect(editor.getByTestId("avatar-preview")).toHaveAttribute("data-avatar", "builtin:v2-space-launch");
  await page.getByTestId("profile-save").click();
  await expect(editor).toBeHidden();
  await expect(tile(page, "Rae").locator("img")).toHaveAttribute("src", "/avatars/v2/v2-space-launch.webp");

  // The library is substantial and every built-in image loads.
  await manage(page, "Rae");
  const all = editor.locator("[data-avatar-id]");
  expect(await all.count()).toBeGreaterThanOrEqual(30);
  await expect.poll(() => all.evaluateAll((els) => els.every((b) => (b.querySelector("img") as HTMLImageElement).naturalWidth > 0)), { timeout: 15_000 }).toBe(true);

  // Cancel discards edits.
  await editor.getByLabel("Name").fill("Should not save");
  await editor.locator("[data-avatar-id=v2-animals-owl]").click();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(tile(page, "Rae")).toBeVisible();
  await expect(tile(page, "Rae").locator("img")).toHaveAttribute("src", "/avatars/v2/v2-space-launch.webp");

  // Save persists across a reload and on the server.
  await manage(page, "Rae");
  await editor.getByLabel("Name").fill("Rae Two");
  await editor.locator("[data-avatar-id=v2-animals-owl]").click();
  await page.getByTestId("profile-save").click();
  await page.reload();
  await expect(tile(page, "Rae Two").locator("img")).toHaveAttribute("src", "/avatars/v2/v2-animals-owl.webp");
  expect((await profilesOf(page)).find((p) => p.name === "Rae Two")?.avatar).toBe("builtin:v2-animals-owl");

  // Delete asks for confirmation.
  await manage(page, "Rae Two");
  await page.getByTestId("profile-delete").click();
  await expect(page.getByRole("alertdialog")).toContainText("Delete “Rae Two”?");
  await page.getByTestId("profile-delete-confirm").click();
  await expect(tile(page, "Rae Two")).toHaveCount(0);
  expect((await profilesOf(page)).some((p) => p.name === "Rae Two")).toBe(false);
});

test("custom photo: zoom and reposition, stored as a cropped 256 px WebP that survives reloads", async ({ page, request, browser, baseURL }) => {
  await signedIn(page, request);
  const kidsBefore = (await profilesOf(page)).find((p) => p.name === "Kids")!.avatar;
  await manage(page, "Main");
  const editor = page.getByTestId("profile-editor");

  // Not an image: refused before upload.
  await editor.getByTestId("avatar-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("profile-error")).toHaveText("Choose a JPEG, PNG or WebP image.");

  await editor.getByTestId("avatar-file").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: await splitImage() });
  const area = editor.getByTestId("avatar-crop-area");
  await expect(area).toBeVisible();
  await expect.poll(() => area.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
  // Zoom in, then drag the image far left: the crop moves to the right (blue) edge.
  await editor.getByTestId("avatar-zoom").fill("2");
  const box = (await area.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 600, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId("profile-save").click();
  await expect(editor).toBeHidden({ timeout: 20_000 });

  const img = tile(page, "Main").locator("img");
  await expect(img).toHaveAttribute("src", /^\/api\/user\/avatar\//);
  const src = (await img.getAttribute("src"))!;
  const res = await page.request.get(src);
  expect(res.headers()["content-type"]).toBe("image/webp");
  const stored = Buffer.from(await res.body());
  const meta = await sharp(stored).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 256]);
  expect(meta.exif).toBeUndefined();
  // Zoomed 2× and pushed to the right edge: the whole square is the blue half.
  for (const [x, y] of [[10, 10], [128, 128], [245, 245]]) {
    const p = await pixel(stored, x, y);
    expect(p.b).toBeGreaterThan(200);
    expect(p.r).toBeLessThan(60);
  }

  // Persists across reloads; another profile's avatar is untouched.
  await page.reload();
  await expect(tile(page, "Main").locator("img")).toHaveAttribute("src", src);
  await expect.poll(() => tile(page, "Main").locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(256);
  expect((await profilesOf(page)).find((p) => p.name === "Kids")!.avatar).toBe(kidsBefore);

  // Server-side validation: bytes that are not an image are refused even with an image type.
  const profileId = (await profilesOf(page)).find((p) => p.name === "Main")!.id;
  const fake = await page.request.post("/api/user/avatar", {
    multipart: { profileId, file: { name: "x.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") } },
  });
  expect(fake.status()).toBe(422);
  expect((await fake.json()).error).toMatch(/JPEG, PNG or WebP/);

  // Uploaded photos are private to the account.
  const other = await browser.newContext({ baseURL });
  await other.request.post("/api/auth/signup", { data: { name: uniqueName("e2e-other"), password: PASSWORD } });
  expect((await other.request.get(src)).status()).toBe(404);
  await other.close();
});

test("PIN-protected profile, and My List / preferences / history isolated per profile", async ({ page, request }) => {
  await signedIn(page, request);
  await page.goto("/profiles");
  await page.getByTestId("profile-add").click();
  const editor = page.getByTestId("profile-editor");
  await editor.getByLabel("Name").fill("Locked");
  await page.getByTestId("profile-pin-toggle").check();
  await page.getByTestId("profile-pin").fill("2468");
  await page.getByTestId("profile-save").click();
  // Setting a PIN needs the account password.
  await expect(page.getByTestId("profile-error")).toContainText("account password");
  await page.getByTestId("profile-password").fill(PASSWORD);
  await page.getByTestId("profile-save").click();
  await expect(editor).toBeHidden();
  await expect(tile(page, "Locked")).toHaveAttribute("aria-label", /PIN protected/);

  // Entering the profile asks for the PIN.
  await tile(page, "Locked").click();
  const pin = page.getByTestId("pin-dialog");
  await expect(pin).toBeVisible();
  await pin.getByTestId("pin-input").fill("1111");
  await expect(pin.getByRole("alert")).toHaveText("That PIN is not correct.");
  await pin.getByTestId("pin-input").fill("2468");
  await page.waitForURL(/\/browse/);

  const profiles = await profilesOf(page);
  const locked = profiles.find((p) => p.name === "Locked")!;
  const main = profiles.find((p) => p.name === "Main")!;
  expect(locked.hasPin).toBe(true);
  expect("pinHash" in locked).toBe(false);

  // In "Locked": save a title and a preference. A crafted request that also targets "Main" only changes "Locked".
  const put = await page.request.put("/api/user/state", {
    data: { myListByProfile: { [locked.id]: ["tmdb-862"], [main.id]: ["tmdb-603"] }, continueWatchingByProfile: { [locked.id]: { "tmdb-862": 40 }, [main.id]: { "tmdb-603": 50 } } },
  });
  expect(put.ok()).toBe(true);
  expect((await page.request.put("/api/user/state", { data: { action: "setPreferences", preferences: { audioLanguage: "fr" } } })).ok()).toBe(true);
  expect((await page.request.put("/api/user/state", { data: { action: "setPreferences", profileId: main.id, preferences: { audioLanguage: "de" } } })).status()).toBe(403);
  let state = (await (await page.request.get("/api/auth/me")).json()).state;
  expect(state.myListByProfile[locked.id]).toEqual(["tmdb-862"]);
  expect(state.myListByProfile[main.id] ?? []).toEqual([]);
  expect(state.continueWatchingByProfile[main.id] ?? {}).toEqual({});
  expect(state.preferencesByProfile[locked.id].audioLanguage).toBe("fr");

  // Switch profile → Main sees its own (empty) list and default preferences.
  await page.reload();
  await page.getByTestId("profile-menu-button").click();
  await page.getByTestId("menu-switch-profile").click();
  await page.waitForURL(/\/profiles$/);
  await tile(page, "Main").click();
  await page.waitForURL(/\/browse/);
  await page.goto("/browse/my-list");
  await expect(page.getByTestId("my-list-empty")).toBeVisible({ timeout: 20_000 });
  await page.goto("/settings");
  await expect(page.getByTestId("pref-audio-language")).toHaveValue("en");
  state = (await (await page.request.get("/api/auth/me")).json()).state;
  expect(state.activeProfileId).toBe(main.id);

  // The PIN is enforced by the server, with a limit on guesses.
  for (let i = 0; i < 5; i++) {
    const r = await page.request.post("/api/user/profiles", { data: { action: "select", profileId: locked.id, pin: String(1000 + i) } });
    expect(r.status()).toBe(403);
  }
  expect((await page.request.post("/api/user/profiles", { data: { action: "select", profileId: locked.id, pin: "2468" } })).status()).toBe(429);
});
