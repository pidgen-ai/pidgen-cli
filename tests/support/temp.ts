import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temporary directories for tests. Every directory made here is recorded, and the setup file
 * (tests/support/setup.ts, `setupFiles` in the vitest configs) removes them all when the test file
 * finishes. Set PIDGEN_KEEP_TEST_DIRS=1 to keep them for debugging. Tests make their temporary
 * directories here, not with mkdtemp, so a test run leaves nothing in os.tmpdir().
 */
const made = new Set<string>();

export async function tempDir(prefix = "pidgen-test-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  made.add(directory);
  return directory;
}

export function tempDirSync(prefix = "pidgen-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  made.add(directory);
  return directory;
}

/** True when PIDGEN_KEEP_TEST_DIRS=1 asks to keep test directories for debugging. */
export function keepTestDirs(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PIDGEN_KEEP_TEST_DIRS"] === "1";
}

/**
 * Removes every directory made since the last call (rm -r, force), unless PIDGEN_KEEP_TEST_DIRS=1.
 * Returns the directories it removed, or kept.
 */
export function removeTempDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const directories = [...made];
  made.clear();
  if (keepTestDirs(env)) return directories;
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  return directories;
}
