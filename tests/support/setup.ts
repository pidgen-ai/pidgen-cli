import { afterAll } from "vitest";
import { keepTestDirs, removeTempDirs } from "./temp.js";

// Registered for every test file (`setupFiles` in vitest.config.ts and vitest.contract.config.ts).
// Hooks run in stack order, so this afterAll runs after the test file's own afterAll hooks.
afterAll(() => {
  const directories = removeTempDirs();
  if (keepTestDirs() && directories.length > 0) {
    process.stderr.write(`PIDGEN_KEEP_TEST_DIRS=1 kept:\n${directories.join("\n")}\n`);
  }
});
