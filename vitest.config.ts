import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __PIDGEN_VERSION__: JSON.stringify("0.0.0-test") },
  test: {
    include: ["tests/**/*.test.ts"],
    // Contract tests start a Prism mock server; they run with `npm run test:contract`.
    exclude: ["tests/contract/**", "**/node_modules/**"],
    environment: "node",
  },
});
