import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __PIDGEN_VERSION__: JSON.stringify("0.0.0-test") },
  test: {
    include: ["tests/**/*.test.ts"],
    // Contract tests start a Prism mock server; they run with `npm run test:contract`.
    exclude: ["tests/contract/**", "**/node_modules/**"],
    environment: "node",
    // Human output writes times in the machine's zone; no test may assume UTC (src/core/time.ts).
    env: { TZ: "America/Los_Angeles" },
    // Removes the temporary directories tests make (tests/support/temp.ts).
    setupFiles: ["tests/support/setup.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
  },
});
