import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const CONFIG = join(ROOT, "tests", "fixtures", "temp-dirs", "vitest.config.ts");

let privateTmp: string | undefined;
afterEach(async () => {
  if (privateTmp !== undefined) await rm(privateTmp, { recursive: true, force: true });
  privateTmp = undefined;
});

/** Runs the fixture test file in a child vitest whose os.tmpdir() is a fresh, empty directory. */
async function runFixture(env: Record<string, string> = {}) {
  // This directory is the test's own: it is the child's TMPDIR, removed in afterEach.
  privateTmp = await mkdtemp(join(tmpdir(), "pidgen-temp-test-"));
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    TMPDIR: privateTmp,
    TMP: privateTmp,
    TEMP: privateTmp,
    ...env,
  };
  if (env["PIDGEN_KEEP_TEST_DIRS"] === undefined) delete childEnv["PIDGEN_KEEP_TEST_DIRS"];
  const result = spawnSync(process.execPath, [VITEST, "run", "--config", CONFIG], {
    cwd: ROOT,
    env: childEnv,
    encoding: "utf8",
  });
  const left = (await readdir(privateTmp)).filter((name) => name !== "node-compile-cache");
  return { status: result.status, output: `${result.stdout}${result.stderr}`, left };
}

describe("temporary directories made by tests", () => {
  it("AC-8dd96c02fbaa AC-c94a272bb852: are all removed when their test file finishes", async () => {
    const { status, output, left } = await runFixture();
    expect(status, output).toBe(0);
    expect(output).toContain("1 passed");
    expect(left).toEqual([]);
  }, 60_000);

  it("AC-b6264d753364: are kept when PIDGEN_KEEP_TEST_DIRS=1", async () => {
    const { status, output, left } = await runFixture({ PIDGEN_KEEP_TEST_DIRS: "1" });
    expect(status, output).toBe(0);
    expect(left.filter((name) => name.startsWith("pidgen-fixture-"))).toHaveLength(2);
    expect(left.filter((name) => name.startsWith("pidgen-test-"))).toHaveLength(1);
  }, 60_000);
});

describe("the full-run check (AC-8dd96c02fbaa)", () => {
  it("package.json runs scripts/test-tmp-check.mjs as test:tmp-check", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:tmp-check"]).toBe("node scripts/test-tmp-check.mjs");
  });

  it("CI runs the unit tests through it, so a run that leaves anything in the temporary directory fails", async () => {
    const workflow = parse(await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    const runs = workflow.jobs["test"]?.steps.map((step) => step.run ?? "") ?? [];
    expect(runs).toContain("npm run test:tmp-check");
    expect(runs).not.toContain("npm test");
  });
});
