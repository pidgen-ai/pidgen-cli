import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkDocs, githubSlug } from "../../scripts/docs-bundle.mjs";

const ROOT = new URL("../../", import.meta.url);
const FIXTURES = "tests/scripts/fixtures/docs-bundle";
const execFileAsync = promisify(execFile);

/** Runs `node scripts/docs-bundle.mjs check <dir>` from the repository root. */
async function check(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/docs-bundle.mjs", "check", dir],
      { cwd: ROOT.pathname },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("docs-bundle check", () => {
  it("passes the real docs/", async () => {
    const result = await check("docs");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Docs check passed");
  });

  it("checks docs/ by default", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/docs-bundle.mjs", "check"], {
      cwd: ROOT.pathname,
    });
    expect(stdout).toContain("docs");
  });

  it("passes a valid fixture: fenced examples with pidgen.example.com, ACC-EXAMPLE, GitHub slugs", async () => {
    const result = await check(`${FIXTURES}/valid`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses an unknown command with exit 2", async () => {
    const code = await execFileAsync(process.execPath, ["scripts/docs-bundle.mjs", "nope"], {
      cwd: ROOT.pathname,
    }).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    expect(code).toBe(2);
  });
});

describe("navigation.json (criterion check-navigation)", () => {
  it.each([
    ["nav-missing", "second.md", /not listed in navigation\.json/],
    ["nav-duplicate", "second.md", /listed 2 times in navigation\.json/],
    ["nav-no-file", "ghost.md", /listed in navigation\.json but .*does not exist/],
  ])("%s fails naming %s", async (fixture, page, message) => {
    const result = await check(`${FIXTURES}/${fixture}`);
    expect(result.code).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line.includes(page));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(message);
  });

  it("does not require README.md to be listed", async () => {
    const problems = await checkDocs(new URL(`${FIXTURES}/valid`, ROOT).pathname);
    expect(problems).toEqual([]);
  });
});

describe("links and anchors (criterion check-links)", () => {
  it.each([
    ["broken-anchor", "first.md", /second\.md#flags-and-option/],
    ["broken-fragment", "first.md", /#no-such-heading/],
    ["broken-link", "first.md", /third\.md/],
  ])("%s fails naming %s", async (fixture, page, message) => {
    const result = await check(`${FIXTURES}/${fixture}`);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`${page.replace(".", "\\.")}:\\d+: `));
    expect(result.stderr).toMatch(message);
  });

  it("slugs headings as GitHub does", () => {
    expect(githubSlug("The `--format` flag")).toBe("the---format-flag");
    expect(githubSlug("What it returns — why")).toBe("what-it-returns--why");
    expect(githubSlug("2. Sign in")).toBe("2-sign-in");
    expect(githubSlug("auth login --with-token")).toBe("auth-login---with-token");
    expect(githubSlug("The App Service's view")).toBe("the-app-services-view");
    expect(githubSlug("[Linked](other.md) *heading*")).toBe("linked-heading");
    expect(githubSlug("snake_case name")).toBe("snake_case-name");
  });
});

describe("private material (criterion check-private)", () => {
  it.each([
    ["adr", "ADR-12"],
    ["localhost", "localhost"],
    ["loopback", "127.0.0.1"],
    ["lan", "192.168.1.20"],
    ["lan-10", "10.0.4.7"],
    ["home", "/home/"],
    ["srv", "/srv/"],
    ["gitea", "Gitea"],
    ["account", "ACC-7Q2X9"],
    ["token", "pidgen_cli_9fK2mQ7xLw3ZpR8tY1vB"],
  ])("private-%s fails naming first.md and %s", async (fixture, text) => {
    const result = await check(`${FIXTURES}/private-${fixture}`);
    expect(result.code).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => /first\.md:\d+: /.test(line));
    expect(lines.join("\n")).toContain(text);
  });

  it("accepts pidgen.example.com and ACC-EXAMPLE inside fenced code", async () => {
    const valid = await readFile(new URL(`${FIXTURES}/valid/first.md`, ROOT), "utf8");
    expect(valid).toMatch(/```sh\n.*pidgen\.example\.com.*ACC-EXAMPLE/);
    expect(await checkDocs(new URL(`${FIXTURES}/valid`, ROOT).pathname)).toEqual([]);
  });
});

describe("CI wiring (criterion check-ci)", () => {
  it.each([".github/workflows/ci.yml", ".github/workflows/release.yml"])(
    "%s runs npm run docs:check before the build",
    async (file) => {
      const workflow = await readFile(new URL(file, ROOT), "utf8");
      const check = workflow.indexOf("run: npm run docs:check");
      const build = workflow.indexOf("run: npm run build");
      expect(check).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(-1);
      expect(check).toBeLessThan(build);
    },
  );

  it("package.json defines docs:check", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["docs:check"]).toBe("node scripts/docs-bundle.mjs check");
  });
});

const REPOSITORY = "https://github.com/pidgen-ai/pidgen-cli";

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** Packs `args` (after `pack`) into a fresh temporary directory, then unpacks the archive. */
async function pack(command: string, args: string[]) {
  const out = await mkdtemp(join(tmpdir(), "docs-pack-"));
  const run =
    command === "npm"
      ? ["run", "--silent", "docs:pack", "--"]
      : ["scripts/docs-bundle.mjs", "pack"];
  const executable = command === "npm" ? "npm" : process.execPath;
  const { code, stdout, stderr } = await execFileAsync(
    executable,
    [...run, ...args, "--out", out],
    { cwd: ROOT.pathname },
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
  const archives = await readdir(out);
  const unpacked = join(out, "unpacked");
  if (code === 0 && archives.length === 1) {
    await execFileAsync("mkdir", [unpacked]);
    await execFileAsync("tar", ["-xzf", join(out, archives[0]!), "-C", unpacked]);
  }
  return { out, code, stdout, stderr, archives, unpacked };
}

describe("docs-bundle pack (criterion pack-archive)", () => {
  let packed: Awaited<ReturnType<typeof pack>>;
  beforeAll(async () => {
    packed = await pack("npm", []);
  }, 60_000);
  afterAll(async () => {
    await rm(packed.out, { recursive: true, force: true });
  });

  it("package.json defines docs:pack", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["docs:pack"]).toBe("node scripts/docs-bundle.mjs pack");
  });

  it("npm run docs:pack writes pidgen-cli-docs-<version>.tar.gz", async () => {
    expect(packed.stderr).toBe("");
    expect(packed.code).toBe(0);
    expect(packed.archives).toEqual([`pidgen-cli-docs-${await packageVersion()}.tar.gz`]);
  });

  it("the archive's docs-bundle.json names format 1, product cli, the version and the commit", async () => {
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT.pathname,
    });
    const manifest = JSON.parse(
      await readFile(join(packed.unpacked, "docs-bundle.json"), "utf8"),
    ) as unknown;
    expect(manifest).toEqual({
      format: 1,
      product: "cli",
      version: await packageVersion(),
      commit: head.trim(),
      navigation: "navigation.json",
    });
  });

  it("holds README.md, navigation.json and the pages it lists, nothing else", async () => {
    const navigation = JSON.parse(
      await readFile(new URL("docs/navigation.json", ROOT), "utf8"),
    ) as { groups: Array<{ pages: Array<{ path: string }> }> };
    const pages = navigation.groups.flatMap((group) => group.pages.map((page) => page.path));
    const { stdout } = await execFileAsync("tar", ["-tzf", join(packed.out, packed.archives[0]!)]);
    expect(stdout.trim().split("\n").sort()).toEqual(
      ["README.md", "docs-bundle.json", "navigation.json", ...pages].sort(),
    );
    expect(await readFile(join(packed.unpacked, "navigation.json"), "utf8")).toBe(
      await readFile(new URL("docs/navigation.json", ROOT), "utf8"),
    );
  });

  it("the unpacked bundle passes the docs bundle check", async () => {
    expect(await checkDocs(packed.unpacked)).toEqual([]);
  });

  it("refuses docs that fail the check and writes no archive", async () => {
    const failed = await pack("node", [`${FIXTURES}/broken-link`]);
    try {
      expect(failed.code).toBe(1);
      expect(failed.stderr).toMatch(/third\.md/);
      expect(failed.archives).toEqual([]);
    } finally {
      await rm(failed.out, { recursive: true, force: true });
    }
  });

  describe("links that leave docs/ (criterion pack-links)", () => {
    it("README.md's ../CONTRIBUTING.md links to the tagged GitHub URL", async () => {
      const version = await packageVersion();
      const readme = await readFile(join(packed.unpacked, "README.md"), "utf8");
      expect(readme).toContain(`](${REPOSITORY}/blob/v${version}/CONTRIBUTING.md)`);
      expect(readme).not.toContain("../CONTRIBUTING.md");
    });

    it("a link to a repository directory (../skills) links to the tagged GitHub tree", async () => {
      const version = await packageVersion();
      const skills = await readFile(join(packed.unpacked, "skills.md"), "utf8");
      expect(skills).toContain(`](${REPOSITORY}/tree/v${version}/skills)`);
      expect(skills).not.toContain("](../skills)");
    });

    it("rewrites only links leaving the docs, keeping fragments, code and bundle links", async () => {
      const fixture = await pack("node", [`${FIXTURES}/valid`]);
      try {
        expect(fixture.code).toBe(0);
        const version = await packageVersion();
        const first = await readFile(join(fixture.unpacked, "first.md"), "utf8");
        const original = await readFile(new URL(`${FIXTURES}/valid/first.md`, ROOT), "utf8");
        const expected = original
          .replace(
            "](../../../../../CONTRIBUTING.md)",
            `](${REPOSITORY}/blob/v${version}/CONTRIBUTING.md)`,
          )
          .replace("](../../../../../skills)", `](${REPOSITORY}/tree/v${version}/skills)`);
        expect(expected).not.toBe(original);
        expect(first).toBe(expected);
        expect(await readFile(join(fixture.unpacked, "second.md"), "utf8")).toBe(
          await readFile(new URL(`${FIXTURES}/valid/second.md`, ROOT), "utf8"),
        );
      } finally {
        await rm(fixture.out, { recursive: true, force: true });
      }
    });
  });
});

describe("release workflow (criterion pack-release)", () => {
  type Step = { name?: string; run?: string; env?: Record<string, string> };
  type Workflow = {
    permissions?: Record<string, string>;
    jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
  };

  it("packs after npm publish and uploads the archive to the tag's release", async () => {
    const workflow = parse(
      await readFile(new URL(".github/workflows/release.yml", ROOT), "utf8"),
    ) as Workflow;
    const job = workflow.jobs.publish!;
    expect(job.permissions).toEqual({ contents: "write", "id-token": "write" });

    const steps = job.steps;
    const publish = steps.findIndex((step) => /\bnpm publish\b/.test(step.run ?? ""));
    const packStep = steps.findIndex((step) => /npm run docs:pack/.test(step.run ?? ""));
    const upload = steps.findIndex((step) => /gh release upload/.test(step.run ?? ""));
    expect(publish).toBeGreaterThan(-1);
    expect(packStep).toBeGreaterThan(publish);
    expect(upload).toBeGreaterThan(packStep);

    const run = steps[upload]!.run!;
    expect(run).toMatch(
      /gh release upload "\$GITHUB_REF_NAME" "?pidgen-cli-docs-\$\{?version\}?\.tar\.gz"? --clobber/,
    );
    expect(run).toMatch(/gh release create "\$GITHUB_REF_NAME"/);
    expect(steps[upload]!.env?.GH_TOKEN).toMatch(/github\.token|secrets\.GITHUB_TOKEN/);
  });
});

describe("worker docs handoff (criterion links-present)", () => {
  const WORKER_DOCS = "https://docs.pidgen.ai/worker";
  const PAGES = ["configure", "coding-agents", "troubleshooting", "run-as-a-service"];

  /** The body of the section headed `## <title>`, up to the next `## ` heading. */
  function section(text: string, title: string): string {
    const start = text.indexOf(`\n## ${title}\n`);
    expect(start, `section "${title}"`).toBeGreaterThan(-1);
    const end = text.indexOf("\n## ", start + 1);
    return text.slice(start, end === -1 ? undefined : end);
  }

  it("install-worker.md hands off to the worker's pages in 'Operate your worker'", async () => {
    const text = await readFile(new URL("docs/install-worker.md", ROOT), "utf8");
    const operate = section(text, "Operate your worker");
    for (const page of PAGES) {
      expect(operate).toContain(`](${WORKER_DOCS}/${page}/)`);
    }
  });

  it("install-worker.md links to the worker's configure and coding agents pages after the readiness checks", async () => {
    const text = await readFile(new URL("docs/install-worker.md", ROOT), "utf8");
    const ready = section(text, "2. Confirm the worker is ready");
    expect(ready).toContain(`](${WORKER_DOCS}/configure/)`);
    expect(ready).toContain(`](${WORKER_DOCS}/coding-agents/)`);
  });

  it("workers.md links to the same four worker pages", async () => {
    const text = await readFile(new URL("docs/workers.md", ROOT), "utf8");
    for (const page of PAGES) {
      expect(text).toContain(`](${WORKER_DOCS}/${page}/)`);
    }
  });
});
