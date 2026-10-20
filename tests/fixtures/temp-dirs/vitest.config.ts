import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../../vitest.config.js";

/**
 * Runs only the fixture test files beside this config, with the repository's setup files, so
 * tests/support/temp.test.ts can observe what one test file leaves in the temporary directory.
 * `include` is replaced, not merged: merging would also run temp.test.ts, which runs this config.
 */
export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: { ...base.test, include: ["tests/fixtures/temp-dirs/*.fixture.ts"] },
});
