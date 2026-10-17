import { defineConfig } from "vitest/config";

/**
 * Contract tests: the HTTP client against a Prism mock server (tests/support/mock-server.ts).
 * Run with `npm run test:contract`; they are kept out of `npm test`. Files run one at a time: each
 * starts its own Prism, which watches its document, and many at once can exhaust the machine's file
 * watchers.
 */
export default defineConfig({
  define: { __PIDGEN_VERSION__: JSON.stringify("0.0.0-test") },
  test: {
    include: ["tests/contract/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
