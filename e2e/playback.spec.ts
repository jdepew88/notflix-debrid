import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createAccount, signInThroughUi, uniqueName } from "./helpers";

test.describe.configure({ mode: "serial" });

test("every generated sample plays in real Chrome through Notflix → media engine", async ({ page, request }) => {
  test.setTimeout(10 * 60_000);
  const name = uniqueName("e2e-play");
  await createAccount(request, name, "e2e-pass-4");
  await signInThroughUi(page, name, "e2e-pass-4");

  await page.goto("/settings/playback-test");
  await expect(page.getByTestId("client-caps")).toBeVisible();
  const caps = await page.getByTestId("client-caps").innerText();
  const results = (await page.evaluate(async () => {
    const w = window as unknown as { __runSelfTest: () => Promise<Record<string, unknown>> };
    for (let i = 0; i < 50 && !w.__runSelfTest; i++) await new Promise((r) => setTimeout(r, 100));
    return w.__runSelfTest();
  })) as Record<string, { ok: boolean; error?: string; mode?: string; pipeline?: string; startupMs?: number; decoded?: string; seek?: string }>;

  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(path.join("test-results", "browser-selftest.json"), JSON.stringify({ caps, results }, null, 2));
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  expect(Object.keys(results).length).toBeGreaterThanOrEqual(10);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  // Direct play really is selected for browser-native files.
  expect(results["h264_aac.mp4"].mode).toBe("Direct Play");
  expect(results["h264_aac.mkv"].mode).toBe("Remux");
  expect(results["h264_dts.mkv"].mode).toBe("Audio Transcode");
});

test("a Real-Debrid title plays in the Notflix player with live diagnostics", async ({ page, request }) => {
  test.skip(!process.env.E2E_LIVE_DEBRID, "set E2E_LIVE_DEBRID=1 to exercise a live Real-Debrid source");
  test.setTimeout(4 * 60_000);
  const name = uniqueName("e2e-rd");
  await createAccount(request, name, "e2e-pass-5");
  await signInThroughUi(page, name, "e2e-pass-5");

  // Public-domain film (Night of the Living Dead, 1968).
  const clicked = Date.now();
  await page.goto("/watch/tmdb-10331?type=movie&title=Night%20of%20the%20Living%20Dead");
  const video = page.locator("video").first();
  await expect(video).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return !!v && v.currentTime > 2 && !v.paused;
  }, undefined, { timeout: 90_000 });
  const startupMs = Date.now() - clicked;

  // No technical jargon on screen during successful playback.
  const visibleText = await page.locator("body").innerText();
  for (const word of ["FFmpeg", "transcod", "HLS", "decoder", "remux"]) expect(visibleText.toLowerCase()).not.toContain(word.toLowerCase());

  // Right-click inside the player opens the custom menu; outside it does not.
  // (The controls overlay covers the <video>, as it does for a real user's right-click.)
  const box = (await video.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3, { button: "right" });
  await expect(page.getByRole("button", { name: "Stream information" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy stream diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: "Stream information" }).first().click();
  const summary = page.getByTestId("diagnostics-summary");
  await expect(summary).toContainText("seconds buffered");
  await page.getByRole("button", { name: "Buffering & processing" }).click();
  await expect(page.getByText("Transcoding active")).toBeVisible();
  const summaryText = await summary.innerText();

  await page.getByRole("button", { name: "Close" }).click();
  // Displayed position ("m:ss / h:mm:ss") reflects movie time, not the current stream's time.
  const shownTime = async () => {
    const text = await page.getByText(/^\d+:\d\d(:\d\d)? \/ \d+:\d\d(:\d\d)?$/).first().innerText();
    const parse = (t: string) => t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
    return parse(text.split(" / ")[0]);
  };

  // Keyboard: ArrowRight skips 10 s (focus must not be in an input, as for a real viewer).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const before = await shownTime();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  const afterSkip = await shownTime();
  expect(afterSkip - before).toBeGreaterThanOrEqual(9);

  // Far seek through the progress bar: beyond what has been prepared, so the stream restarts there.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const bar = page.locator("div.group.mb-3.h-1").first();
  const barBox = (await bar.boundingBox())!;
  const seekClicked = Date.now();
  await page.mouse.click(barBox.x + barBox.width * 0.5, barBox.y + barBox.height / 2);
  const duration = await page.getByText(/^\d+:\d\d(:\d\d)? \/ \d+:\d\d(:\d\d)?$/).first().innerText();
  const totalSeconds = duration.split(" / ")[1].split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  // The stream restarts at the target; wait until the new stream actually plays there.
  let afterSeek = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    const playing = await page.evaluate(() => {
      const v = document.querySelector("video");
      return !!v && !v.paused && v.readyState >= 3;
    });
    afterSeek = await shownTime();
    if (playing && Math.abs(afterSeek - totalSeconds / 2) < 60 && !(await page.getByTestId("player-loading").isVisible())) break;
  }
  const seekMs = Date.now() - seekClicked;
  // The restarted stream begins at the keyframe before the target; use the element's own clock.
  const v1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(2000);
  const v2 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(v2 - v1, "playback continues after the far seek").toBeGreaterThan(1);

  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(
    path.join("test-results", "browser-live-debrid.json"),
    JSON.stringify({ startupMs, summaryText, before, afterSkip, afterSeek, seekMs, duration }, null, 2)
  );
  const total = duration.split(" / ")[1].split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  expect(Math.abs(afterSeek - total / 2)).toBeLessThan(60);
});
