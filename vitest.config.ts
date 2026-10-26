import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/test/setup-data-dir.ts"],
    // scrypt at OWASP cost takes a few hundred ms per hash.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next.js aliases this marker package; outside Next it is a no-op.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
});
