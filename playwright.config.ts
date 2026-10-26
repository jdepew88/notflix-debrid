import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against an already running Notflix (default: the isolated test instance
 * started by `scripts/notflix.ps1 test -Browser`, http://127.0.0.1:8529). They use the installed Google
 * Chrome because Chromium builds lack the proprietary decoders (H.264/HEVC/AAC) real users have.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:8529",
    channel: "chrome",
    headless: process.env.E2E_HEADED ? false : true,
    viewport: { width: 1600, height: 900 },
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
    trace: "retain-on-failure",
  },
});
