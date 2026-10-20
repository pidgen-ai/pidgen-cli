import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { TestProject } from "vitest/node";

/**
 * Vitest makes one directory directly in os.tmpdir() per run for the modules it hands its workers
 * (`Vitest._tmpDir`, a random name with an `ssr/` folder in it) and does not remove it. The
 * teardown removes it when the run ends, unless PIDGEN_KEEP_TEST_DIRS=1. `_tmpDir` is internal, so
 * this does nothing when a later vitest no longer has it or puts it outside os.tmpdir().
 */
export default function setup(project: TestProject) {
  return async () => {
    if (process.env["PIDGEN_KEEP_TEST_DIRS"] === "1") return;
    const directory = (project.vitest as unknown as { _tmpDir?: unknown })._tmpDir;
    if (typeof directory !== "string" || dirname(directory) !== tmpdir()) return;
    await rm(directory, { recursive: true, force: true });
  };
}
