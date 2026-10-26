import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createAccount, signInThroughUi, uniqueName } from "./helpers";

/**
 * Audio/subtitle selection and source switching in the real Notflix player, driven by local
 * fixtures (h264_eng_rus.mkv: Russian 5.1 first/default, English second, untagged third; eng+rus SRT).
 */
async function openPlayer(page: Page, sample: string) {
  await page.goto("/settings/playback-test");
  await page.getByTestId("client-caps").waitFor();
  const ok = await page.evaluate(async (name) => {
    const w = window as unknown as { __openPlayer: (n: string) => Promise<boolean> };
    for (let i = 0; i < 50 && !w.__openPlayer; i++) await new Promise((r) => setTimeout(r, 100));
    return w.__openPlayer(name);
  }, sample);
  expect(ok).toBe(true);
  await page.waitForFunction(() => {
    const v = document.querySelector("[data-testid=player-harness] video") as HTMLVideoElement | null;
    return !!v && v.currentTime > 1.5 && !v.paused;
  }, undefined, { timeout: 60_000 });
}

const video = (page: Page) => page.locator("[data-testid=player-harness] video");
const movieTime = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __playerState?: () => { movieTime: number } };
  return w.__playerState?.().movieTime ?? 0;
});

async function setPref(page: Page, patch: Record<string, unknown>) {
  const me = await (await page.request.get("/api/auth/me")).json();
  const profileId = me.state.activeProfileId ?? me.state.profiles[0].id;
  await page.request.put("/api/user/state", { data: { action: "setPreferences", profileId, preferences: patch } });
}

test("English profile gets the English track (not the first/default Russian) and can switch mid-play without losing position", async ({ page, request }) => {
  test.setTimeout(180_000);
  const name = uniqueName("e2e-audio");
  await createAccount(request, name, "e2e-pass-6");
  await signInThroughUi(page, name, "e2e-pass-6");
  await openPlayer(page, "h264_eng_rus.mkv");

  const menuButton = page.getByTitle("Audio & Subtitles");
  await page.mouse.move(600, 400);
  await menuButton.click();
  const menu = page.getByTestId("track-menu");
  await expect(menu).toBeVisible();
  // Three audio tracks, labelled by real language; the unknown one says so.
  await expect(menu.getByRole("button", { name: /Russian/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: /English/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: /Unknown language/ })).toBeVisible();
  // English is the active (red) one although Russian is first and default.
  await expect(menu.getByRole("button", { name: /English/ })).toHaveClass(/text-netflix-red/);

  // Switch to Russian mid-playback.
  await page.waitForTimeout(3500);
  // The menu is open, so the controls must still be visible and clickable after the idle timeout.
  await expect(menu.getByRole("button", { name: /Russian/ })).toBeVisible();
  const before = await movieTime(page);
  expect(before).toBeGreaterThan(3);
  await menu.getByRole("button", { name: /Russian/ }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector("[data-testid=player-harness] video") as HTMLVideoElement | null;
    return !!v && !v.paused && v.readyState >= 3;
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const after = await movieTime(page);
  expect(after, "position preserved across the audio switch").toBeGreaterThanOrEqual(before - 12);
  expect(after).toBeLessThan(before + 30);
  await page.mouse.move(600, 400);
  await menuButton.click();
  await expect(page.getByTestId("track-menu").getByRole("button", { name: /Russian/ })).toHaveClass(/text-netflix-red/);
});

test("subtitles: embedded SRT by language, off, timing offset and appearance", async ({ page, request }) => {
  test.setTimeout(180_000);
  const name = uniqueName("e2e-subs");
  await createAccount(request, name, "e2e-pass-6");
  await signInThroughUi(page, name, "e2e-pass-6");
  await setPref(page, { subtitlesEnabled: true, subtitleLanguage: "en" });
  await openPlayer(page, "h264_eng_rus.mkv");

  // English subtitles come on by default (preference) as a text track with real cues.
  await expect.poll(async () => video(page).evaluate((v: HTMLVideoElement) => {
    const t = Array.from(v.textTracks).find((x) => x.mode === "showing");
    return t ? (t.cues?.length ?? 0) : 0;
  }), { timeout: 30_000 }).toBeGreaterThan(5);
  const firstCueText = await video(page).evaluate((v: HTMLVideoElement) => {
    const t = Array.from(v.textTracks).find((x) => x.mode === "showing")!;
    return (t.cues![0] as VTTCue).text;
  });
  expect(firstCueText).toMatch(/English line/);

  // Switch to Russian subtitles.
  await page.mouse.move(600, 400);
  await page.getByTitle("Audio & Subtitles").click();
  await page.getByTestId("track-menu").getByRole("button", { name: "Subtitles" }).click();
  await page.getByTestId("track-menu").getByRole("button", { name: /Russian/ }).click();
  await expect.poll(async () => video(page).evaluate((v: HTMLVideoElement) => {
    const t = Array.from(v.textTracks).find((x) => x.mode === "showing");
    return t?.cues?.length ? (t.cues[0] as VTTCue).text : "";
  }), { timeout: 30_000 }).toMatch(/Русская строка/);

  // Timing offset shifts cue start times. (The player rebuilds the cue list on changes, so read it by polling.)
  const secondCueStart = () =>
    video(page).evaluate((v: HTMLVideoElement) => {
      const cue = Array.from(v.textTracks).find((x) => x.mode === "showing")?.cues?.[1] as VTTCue | undefined;
      return cue ? cue.startTime : null;
    });
  await expect.poll(secondCueStart).not.toBeNull();
  const start0 = (await secondCueStart())!;
  await page.mouse.move(600, 400);
  await page.getByTitle("Audio & Subtitles").click();
  await page.getByTestId("track-menu").getByRole("button", { name: "Options" }).click();
  await page.getByRole("button", { name: "+0.25 s" }).click();
  await page.getByRole("button", { name: "+0.25 s" }).click();
  await expect(page.getByTestId("subtitle-offset")).toHaveText("+0.50 s");
  await expect.poll(async () => (await secondCueStart()) ?? Number.NaN, { timeout: 15_000 }).toBeCloseTo(start0 + 0.5, 1);

  // Appearance: yellow text ends up in the ::cue rule.
  await page.getByRole("button", { name: "Yellow" }).click();
  const css = await page.evaluate(() => Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n"));
  expect(css).toMatch(/video::cue[^}]*#ffe14d/);

  // Off.
  await page.getByTestId("track-menu").getByRole("button", { name: "Subtitles" }).click();
  await page.getByTestId("track-menu").getByRole("button", { name: "Off", exact: true }).click();
  await expect.poll(async () => video(page).evaluate((v: HTMLVideoElement) => Array.from(v.textTracks).filter((x) => x.mode === "showing").length)).toBe(0);

  // Preferences persisted server-side (per title and profile).
  const me = await (await page.request.get("/api/auth/me")).json();
  const prefs = me.state.preferencesByProfile[me.state.activeProfileId];
  expect(prefs.subtitleOffsetMs).toBe(500);
  expect(prefs.subtitleStyle.color).toBe("yellow");
});

test("external SRT loads as a caption track", async ({ page, request }) => {
  const name = uniqueName("e2e-extsub");
  await createAccount(request, name, "e2e-pass-6");
  await signInThroughUi(page, name, "e2e-pass-6");
  await openPlayer(page, "h264_aac.mp4");
  await page.mouse.move(600, 400);
  await page.getByTitle("Audio & Subtitles").click();
  await page.getByTestId("track-menu").getByRole("button", { name: "Subtitles" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Load external subtitle/ }).click();
  await (await chooser).setFiles("test-media/h264_aac.en.srt");
  await expect.poll(async () => video(page).evaluate((v: HTMLVideoElement) => Array.from(v.textTracks).filter((x) => x.mode === "showing" && (x.cues?.length ?? 0) > 0).length), { timeout: 15_000 }).toBeGreaterThan(0);
});

test("Change video source: lists releases with verified facts, switches at the same position, survives a failing source", async ({ page, request }) => {
  test.setTimeout(240_000);
  const name = uniqueName("e2e-source");
  await createAccount(request, name, "e2e-pass-6");
  await signInThroughUi(page, name, "e2e-pass-6");
  // Engine status is owner-only in the app, so ask the test instance's engine directly.
  test.skip(!process.env.E2E_DATA_PATH, "E2E_DATA_PATH (the test server's data folder) is needed to read engine load");
  const data = process.env.E2E_DATA_PATH!;
  const enginePort = JSON.parse(fs.readFileSync(path.join(data, "config", "engine.json"), "utf8")).port as number;
  const engineKey = fs.readFileSync(path.join(data, "secrets", "engine-secret"), "utf8").trim();
  const engineSessions = async () =>
    (await (await page.request.get(`http://127.0.0.1:${enginePort}/capabilities`, { headers: { "X-Engine-Key": engineKey } })).json()).load.sessions as number;
  const baseline = await engineSessions(); // sessions of other viewers / earlier tests
  await openPlayer(page, "hevc_ac3_long.mkv");
  await page.waitForTimeout(4000);
  const before = await movieTime(page);

  // Right-click → Change video source.
  const box = (await video(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3, { button: "right" });
  await page.getByTestId("menu-change-source").click();
  const selector = page.getByTestId("source-selector");
  await expect(selector).toBeVisible();
  await expect(selector.getByTestId("source-candidate").first()).toBeVisible({ timeout: 30_000 });
  const count = await selector.getByTestId("source-candidate").count();
  expect(count).toBeGreaterThan(5);
  // Verified facts (ffprobe) appear for checked candidates; unverified ones are labelled as such.
  await expect(selector.getByTestId("verified").first()).toBeVisible({ timeout: 60_000 });
  await expect(selector.getByText(/Verified:/).first()).toBeVisible();
  const engRus = selector.locator("[data-testid=source-candidate]", { has: page.getByText("h264_eng_rus.mkv") });
  await engRus.getByTestId("verify").click().catch(() => undefined);
  await expect(engRus.getByText(/Russian · AC-3 5.1/)).toBeVisible({ timeout: 60_000 });
  await expect(engRus.getByText(/Unknown language/)).toBeVisible();
  await expect(engRus.getByText(/Subtitles: English, Russian/)).toBeVisible();

  // Switch to it: playback continues near the saved position with English audio.
  await engRus.getByTestId("play-source").click();
  await expect(selector).toHaveCount(0, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const v = document.querySelector("[data-testid=player-harness] video") as HTMLVideoElement | null;
    return !!v && !v.paused && v.readyState >= 3;
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const after = await movieTime(page);
  expect(after).toBeGreaterThanOrEqual(Math.min(before, 200) - 12);
  await expect(page.getByText(/Switched to: h264_eng_rus.mkv/)).toBeVisible();
  await page.mouse.move(600, 400);
  await page.getByTitle("Audio & Subtitles").click();
  await expect(page.getByTestId("track-menu").getByRole("button", { name: /English/ })).toHaveClass(/text-netflix-red/);
  await page.getByTitle("Audio & Subtitles").click();

  // A failing replacement keeps the current stream.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3, { button: "right" });
  await page.getByTestId("menu-change-source").click();
  await expect(page.getByTestId("source-selector")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __failNextSwitch?: boolean }).__failNextSwitch = true;
  });
  const other = page.getByTestId("source-selector").locator("[data-testid=source-candidate]", { has: page.getByText("h264_aac.mkv", { exact: true }) });
  await other.getByTestId("play-source").click();
  await expect(page.getByTestId("switch-error")).toBeVisible({ timeout: 60_000 });
  const stillPlaying = await video(page).evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 3);
  expect(stillPlaying).toBe(true);
  // Neither the replaced stream nor the abandoned attempt leaves an engine session behind: only the
  // current one remains (counted against the baseline, since the engine is shared).
  await expect.poll(engineSessions, { timeout: 10_000 }).toBeLessThanOrEqual(baseline + 1);
});
