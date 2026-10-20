import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tempDir, tempDirSync, testContext } from "../../support/context.js";

// Run by tests/support/temp.test.ts in a child vitest whose TMPDIR is a private directory.
it("makes temporary directories and leaves files in them", async () => {
  const named = await tempDir("pidgen-fixture-");
  const synchronous = tempDirSync("pidgen-fixture-");
  const ctx = await testContext();
  for (const directory of [named, synchronous, ctx.homeDir]) {
    writeFileSync(join(directory, "file.txt"), "kept until the file finishes");
    expect(existsSync(directory)).toBe(true);
  }
});
