// Runs vitest with a private, empty temporary directory and fails when the run leaves anything in
// it. Every directory a test makes must be removed when its test file finishes (tests/support/temp.ts),
// so the count of entries is 0 before the run and must still be 0 after it.
//
//   node scripts/test-tmp-check.mjs [vitest arguments...]
//
// The private directory is passed as TMPDIR (and TMP, TEMP), so os.tmpdir() in vitest, its workers
// and every child process resolves to it, and other processes on the machine cannot disturb the count.
// Node's compile cache, which npm enables, is one directory every run shares and reuses; no test
// makes it, so it is not counted.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vitest = join("node_modules", "vitest", "vitest.mjs");
const root = mkdtempSync(join(tmpdir(), "pidgen-tmp-check-"));
const SHARED_CACHES = new Set(["node-compile-cache"]);
const entries = () =>
  readdirSync(root)
    .filter((name) => !SHARED_CACHES.has(name))
    .sort();
const before = entries().length;
let code;
try {
  const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
  delete env["PIDGEN_KEEP_TEST_DIRS"];
  const result = spawnSync(process.execPath, [vitest, "run", ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });
  const left = entries();
  console.log(`Temporary directory entries: ${before} before the run, ${left.length} after it.`);
  if (left.length > before) {
    console.error(`The test run left ${left.length - before} entries in the temporary directory:`);
    for (const name of left) console.error(`  - ${name}`);
    code = 1;
  } else {
    code = result.status ?? 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
