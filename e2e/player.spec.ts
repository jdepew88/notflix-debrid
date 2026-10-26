import { expect, test, type Page } from "@playwright/test";
import { createAccount, signInThroughUi, uniqueName } from "./helpers";

/**
 * The real Notflix player (VideoPlayer + engine session) against deterministic samples:
 * skip, far seek with stream restart, pause/resume, and the right-click diagnostics.
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

const shownTime = async (page: Page) => {
  const text = await page.getByText(/^\d+:\d\d(:\d\d)? \/ \d+:\d\d(:\d\d)?$/).first().innerText();
  const parse = (t: string) => t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  const [now, total] = text.split(" / ").map(parse);
  return { now, total };
};

for (const sample of ["hevc10_opengop_long.mkv", "h264_ac3_gop10_long.mkv", "hevc_ac3_long.mkv"]) {
  test(`Notflix player: skip, far seek restart, pause/resume — ${sample}`, async ({ page, request }) => {
    test.setTimeout(180_000);
    const name = uniqueName("e2e-player");
    await createAccount(request, name, "e2e-pass-6");
    await signInThroughUi(page, name, "e2e-pass-6");
    await openPlayer(page, sample);
    const video = page.locator("[data-testid=player-harness] video");
    const box = (await video.boundingBox())!;

    // Skip forward 10 s with the keyboard.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t0 = (await shownTime(page)).now;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);
    expect((await shownTime(page)).now - t0).toBeGreaterThanOrEqual(9);

    // Far seek with the progress bar (75%).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const bar = page.locator("[data-testid=player-harness] div.group.mb-3.h-1").first();
    const barBox = (await bar.boundingBox())!;
    const { total } = await shownTime(page);
    await page.mouse.click(barBox.x + barBox.width * 0.75, barBox.y + barBox.height / 2);
    const clicked = Date.now();
    let now = 0;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      const playing = await video.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 3);
      now = (await shownTime(page)).now;
      if (playing && Math.abs(now - total * 0.75) < 15) break;
    }
    const seekMs = Date.now() - clicked;
    expect(Math.abs(now - total * 0.75), `landed at ${now}s of ${total}s`).toBeLessThan(15);
    // (A copy-mode restart begins at the keyframe just before the target, so compare the element's
    // own clock rather than the target time shown while restarting.)
    const v1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    await page.waitForTimeout(1500);
    const v2 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(v2 - v1, "playback continues after the far seek").toBeGreaterThan(0.8);

    // Pause and resume.
    await page.keyboard.press("k");
    await page.waitForTimeout(800);
    const paused = await video.evaluate((v: HTMLVideoElement) => v.paused);
    await page.keyboard.press("k");
    await page.waitForTimeout(1200);
    const resumed = await video.evaluate((v: HTMLVideoElement) => !v.paused);
    expect(paused && resumed).toBe(true);

    // Right-click diagnostics inside the player.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3, { button: "right" });
    await page.getByRole("button", { name: "Stream information" }).first().click();
    await expect(page.getByTestId("diagnostics-summary")).toContainText("seconds buffered");
    console.log(`${sample}: far seek ${seekMs} ms → ${now.toFixed(0)}s / ${total}s · ${await page.getByTestId("diagnostics-summary").innerText()}`);
  });
}

test("right-click outside the player keeps the normal browser menu", async ({ page, request }) => {
  const name = uniqueName("e2e-ctx");
  await createAccount(request, name, "e2e-pass-7");
  await signInThroughUi(page, name, "e2e-pass-7");
  await page.goto("/settings/playback-test");
  await page.locator("h1").first().waitFor(); // after the branded loading screen
  const prevented = await page.evaluate(() => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.querySelector("h1")!.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
});
