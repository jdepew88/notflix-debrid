// Every unit test runs against a throwaway data directory, never the machine's real
// %ProgramData%\NotflixDebrid (tests may still point NOTFLIX_DATA_DIR elsewhere themselves).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

if (!process.env.NOTFLIX_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-test-data-"));
  process.env.NOTFLIX_DATA_DIR = dir;
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
}
