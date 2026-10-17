import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = new URL("../../", import.meta.url);
const run = promisify(execFile);

/** The repository's release process: `npm run release:check` and a versioned changelog section. */
describe("the release", () => {
  it("npm run release:check passes: no skill is still imported", async () => {
    const imported = JSON.parse(
      await readFile(new URL("tests/skills/imported.json", ROOT), "utf8"),
    ) as string[];
    expect(imported).toEqual([]);
    const { stdout } = await run(process.execPath, ["scripts/release-check.mjs"], {
      cwd: ROOT.pathname,
    });
    expect(stdout).toContain("Release check passed");
  });

  it("the latest released changelog section matches the package version", async () => {
    const changelog = await readFile(new URL("CHANGELOG.md", ROOT), "utf8");
    const { version } = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")) as {
      version: string;
    };
    // A release, or a prerelease such as 0.1.0-alpha.1.
    expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/);
    expect(version).not.toBe("0.0.0");
    const sections = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    const versioned = sections.filter((heading) => heading !== "Unreleased");
    expect(versioned[0]).toMatch(new RegExp(`^${version.replaceAll(".", "\\.")}\\b`));
    // Development notes belong in Unreleased; the latest published section still matches npm.
    expect(sections[0]).toBe("Unreleased");
    const release = changelog.slice(changelog.indexOf(`## ${versioned[0]}`));
    for (const note of [
      "pidgen ticket actions",
      "pidgen ticket act",
      "pidgen ticket retry",
      "pidgen ticket replay",
    ]) {
      expect(release).toContain(note);
    }
  });
});

describe("the latest dist-tag", () => {
  type Step = { name?: string; run?: string };
  type Workflow = { jobs: Record<string, { steps: Step[] }> };

  /**
   * Runs the release workflow's "Point latest" step for `version` with a fake npm whose current
   * latest is `latest` (absent when undefined). Returns the npm commands it ran.
   */
  async function pointLatest(version: string, latest: string | undefined): Promise<string[]> {
    const workflow = parse(
      await readFile(new URL(".github/workflows/release.yml", ROOT), "utf8"),
    ) as Workflow;
    const step = workflow.jobs.publish!.steps.find((s) => /^Point latest/.test(s.name ?? ""));
    expect(step?.run).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "latest-step-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "pidgen", version }));
      const log = join(dir, "npm.log");
      const view = latest === undefined ? 'echo "404 Not Found" >&2; exit 1' : `echo "${latest}"`;
      await writeFile(
        join(dir, "npm"),
        `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = view ]; then ${view}; fi\n`,
      );
      await chmod(join(dir, "npm"), 0o755);
      await run("bash", ["-e", "-c", step!.run!], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env["PATH"]}` },
      });
      return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("follows a prerelease while latest is missing or a prerelease", async () => {
    expect(await pointLatest("0.1.0-alpha.1", undefined)).toEqual([
      "view pidgen dist-tags.latest",
      "dist-tag add pidgen@0.1.0-alpha.1 latest",
    ]);
    expect(await pointLatest("0.1.0-alpha.2", "0.1.0-alpha.1")).toEqual([
      "view pidgen dist-tags.latest",
      "dist-tag add pidgen@0.1.0-alpha.2 latest",
    ]);
  });

  it("never replaces a release on latest, and leaves a release's own publish alone", async () => {
    expect(await pointLatest("0.2.0-alpha.1", "0.1.0")).toEqual(["view pidgen dist-tags.latest"]);
    expect(await pointLatest("0.1.0", "0.1.0-alpha.3")).toEqual([]);
  });

  it("runs after npm publish, with the npm token", async () => {
    const text = await readFile(new URL(".github/workflows/release.yml", ROOT), "utf8");
    const steps = (parse(text) as Workflow).jobs.publish!.steps as (Step & {
      env?: Record<string, string>;
    })[];
    const publish = steps.findIndex((step) => /\bnpm publish\b/.test(step.run ?? ""));
    const latest = steps.findIndex((step) => /^Point latest/.test(step.name ?? ""));
    expect(latest).toBeGreaterThan(publish);
    expect(steps[latest]!.env?.["NODE_AUTH_TOKEN"]).toBe("${{ secrets.NPM_TOKEN }}");
  });
});
