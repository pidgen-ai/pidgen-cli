import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

// AC-bc2d5eeb9a5f: `pidgen project inspect`, `project setup` and `project rehearse` over the
// readiness routes (contracts/pending/project-readiness.json), with the fixtures under
// tests/fixtures/readiness/.

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const BASE = `${SERVER}/api/v1/projects/STO/readiness`;

const CONFIG: Config = {
  default_profile: "default",
  profiles: {
    default: {
      url: SERVER,
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: TOKEN } },
    },
  },
};

const FIXTURES = new URL("../fixtures/readiness/", import.meta.url);

async function fixture<T = Record<string, unknown>>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8")) as T;
}

async function archiveFixture(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL("proposal.tar.gz", FIXTURES)));
}

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function ok(data: unknown, status = 200): Response {
  return jsonResponse(status, { status: "ok", data }, { "x-request-id": "req_fake_readiness" });
}

function publicError(status: number, code: string, message: string): Response {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details: null, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

function gzipResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/gzip" } });
}

async function setup(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const ctx = await testContext({
    fetch: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
  });
  await saveConfig(ctx, CONFIG);
  return { ctx, calls };
}

async function json(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli([...argv, "--format", "json"], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function table(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  ctx.io.stdoutIsTTY = true;
  const code = await runCli([...argv, "--format", "table"], ctx);
  return { code, text: ctx.out.join("") };
}

/** A git checkout in the context's home, with a subdirectory the command runs from. */
async function checkout(ctx: TestContext): Promise<string> {
  const root = join(ctx.homeDir, "storefront");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(root, "src", "app"), { recursive: true });
  ctx.cwd = join(root, "src", "app");
  return root;
}

// ── A minimal ustar writer, for archives the server must never send. ─────────────────────────

interface Entry {
  name: string;
  mode?: number;
  type?: string;
  content?: string;
  linkname?: string;
}

function tarGz(entries: Entry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(((entry.mode ?? 0o644) & 0o7777).toString(8).padStart(7, "0") + "\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(entry.type ?? "0", 156);
    header.write(entry.linkname ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

describe("pidgen project inspect", () => {
  it("reads GET /projects/{key}/readiness and returns the server's data unchanged", async () => {
    const findings = await fixture("findings.json");
    const { ctx, calls } = await setup(() => ok(findings));
    const { code, body } = await json(ctx, "project", "inspect", "STO");
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(findings);
    expect(body.meta).toMatchObject({ request_id: "req_fake_readiness", account: "ACC-EXAMPLE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: BASE });
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("renders one row per area with its state word and summary, and the open questions with --answer", async () => {
    const findings = await fixture<{
      areas: Array<{ title: string; summary: string; state: string }>;
    }>("findings.json");
    const { ctx } = await setup(() => ok(findings));
    const { code, text } = await table(ctx, "project", "inspect", "STO");
    expect(code).toBe(ExitCode.Ok);
    expect(text).toContain("Storefront (STO)");
    expect(text).toContain("example-org/storefront");
    const lines = text.split("\n");
    const words: Record<string, string> = {
      ok: "ok",
      proposed: "proposed",
      needs_you: "needs you",
      cannot_tell: "cannot tell",
      pending: "pending",
    };
    // One row per area, in the server's order: the state word, the area's name, its summary.
    let previous = -1;
    for (const area of findings.areas) {
      const rows = lines.filter((line) => line.includes(area.title) && line.includes(area.summary));
      expect(rows, area.title).toHaveLength(1);
      expect(rows[0]!.trimStart().startsWith(words[area.state]!), rows[0]).toBe(true);
      const index = lines.indexOf(rows[0]!);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(text).not.toContain("needs_you");
    // The open question, with the evidence and the command that answers it and inspects again.
    expect(text).toContain("Open questions");
    expect(text).toContain(
      "Should workspaces receive STRIPE_TEST_KEY, or do the tests that need it skip?",
    );
    expect(text).toContain(".github/workflows/ci.yml passes secrets.STRIPE_TEST_KEY");
    expect(text).toContain("pidgen project inspect STO --answer stripe-test-key=<pass|skip>");
    expect(text.indexOf("Open questions")).toBeGreaterThan(
      text.indexOf(findings.areas.at(-1)!.title),
    );
  });

  it("lists no question once it is answered, and says the repository is being inspected again", async () => {
    const inspecting = await fixture("inspecting.json");
    const { ctx } = await setup(() => ok(inspecting));
    const { code, text } = await table(ctx, "project", "inspect", "STO");
    expect(code).toBe(ExitCode.Ok);
    expect(text).not.toContain("Open questions");
    expect(text).not.toContain("--answer");
    expect(text).toMatch(/Inspecting example-org\/storefront at main/);
  });

  it("--answer id=value posts the answers to /readiness/answers and renders the re-inspection", async () => {
    const inspecting = await fixture("inspecting.json");
    const { ctx, calls } = await setup(() => ok(inspecting, 202));
    const { code, body } = await json(
      ctx,
      "project",
      "inspect",
      "STO",
      "--answer",
      "stripe-test-key=skip",
      "--answer",
      "monorepo-packages=api, web",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(inspecting);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/answers` });
    expect(calls[0]!.body).toEqual({
      answers: [
        { question_id: "stripe-test-key", value: "skip" },
        { question_id: "monorepo-packages", value: "api, web" },
      ],
    });
  });

  it.each([["no-equals"], ["=skip"], ["stripe-test-key="], [" =x"]])(
    "--answer %s is CLI_USAGE (exit 2) and sends nothing",
    async (answer) => {
      const { ctx, calls } = await setup(() => ok({}));
      const { code, body } = await json(ctx, "project", "inspect", "STO", "--answer", answer);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
      expect(calls).toHaveLength(0);
    },
  );

  it("a missing key is CLI_USAGE (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup(() => ok({}));
    const { code, body } = await json(ctx, "project", "inspect");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("keeps the server's refusal: PROJECT_NOT_FOUND exits 4, READINESS_QUESTION_UNKNOWN exits 2", async () => {
    const missing = await setup(() => publicError(404, "PROJECT_NOT_FOUND", "No such project."));
    const notFound = await json(missing.ctx, "project", "inspect", "NOPE");
    expect(notFound.code).toBe(ExitCode.NotFound);
    expect(notFound.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const unknown = await setup(() =>
      publicError(422, "READINESS_QUESTION_UNKNOWN", "Storefront has no question nope."),
    );
    const refused = await json(unknown.ctx, "project", "inspect", "STO", "--answer", "nope=1");
    expect(refused.code).toBe(ExitCode.Usage);
    expect(refused.body.error).toMatchObject({ code: "READINESS_QUESTION_UNKNOWN" });
  });

  it("an answer that does not match the contract is UNEXPECTED_RESPONSE (exit 1)", async () => {
    const { ctx } = await setup(() => ok({ project_key: "STO" }));
    const { code, body } = await json(ctx, "project", "inspect", "STO");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });
});

describe("pidgen project setup", () => {
  it("without flags shows the proposed files and how to write them, writing nothing", async () => {
    const findings = await fixture<{ proposal: unknown }>("findings.json");
    const { ctx, calls } = await setup(() => ok(findings));
    const root = await checkout(ctx);
    const { code, body } = await json(ctx, "project", "setup", "STO");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(findings.proposal);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}`]);
    await expect(lstat(join(root, ".pidgen"))).rejects.toThrow();

    const human = await table(ctx, "project", "setup", "STO");
    expect(human.text).toContain(".pidgen/pidgen.toml");
    expect(human.text).toMatch(/\.pidgen\/scripts\/provision +executable/);
    expect(human.text).toContain("pidgen project setup STO --write");
    expect(human.text).toContain("pidgen project setup STO --pull-request");
  });

  it("--write extracts the archive under .pidgen/ at the checkout's root, preserving executable bits", async () => {
    const archive = await archiveFixture();
    const { ctx, calls } = await setup(() => gzipResponse(archive));
    const root = await checkout(ctx);
    const { code, body } = await json(ctx, "project", "setup", "STO", "--write");
    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${BASE}/proposal/archive` });
    expect(calls[0]!.headers["accept"]).toContain("application/gzip");

    const scripts = ["activate", "provision", "teardown", "test"];
    for (const script of scripts) {
      const mode = (await stat(join(root, ".pidgen", "scripts", script))).mode;
      expect(mode & 0o111, script).toBe(0o111);
    }
    const manifest = await stat(join(root, ".pidgen", "pidgen.toml"));
    expect(manifest.mode & 0o111).toBe(0);
    expect(await readFile(join(root, ".pidgen", "pidgen.toml"), "utf8")).toContain(
      'command = ".pidgen/scripts/test"',
    );
    expect(await readFile(join(root, ".pidgen", "scripts", "test"), "utf8")).toMatch(
      /^#!\/bin\/sh/,
    );
    expect(body.data).toEqual({
      project_key: "STO",
      root,
      files: [
        { path: ".pidgen/pidgen.toml", executable: false, status: "created" },
        ...scripts.map((script) => ({
          path: `.pidgen/scripts/${script}`,
          executable: true,
          status: "created",
        })),
      ],
    });

    // Writing the same files again changes nothing.
    const again = await json(ctx, "project", "setup", "STO", "--write");
    expect(again.code).toBe(ExitCode.Ok);
    const files = (again.body.data as { files: Array<{ status: string }> }).files;
    expect(files.map((file) => file.status)).toEqual(Array(5).fill("unchanged"));

    const human = await table(ctx, "project", "setup", "STO", "--write");
    expect(human.text).toContain(`under .pidgen/ in ${root}`);
    expect(human.text).toContain("pidgen project rehearse STO");
  });

  it("--write refuses to replace a file that differs in an existing .pidgen/ (FILES_EXIST, exit 5) unless --force", async () => {
    const archive = await archiveFixture();
    const { ctx } = await setup(() => gzipResponse(archive));
    const root = await checkout(ctx);
    await mkdir(join(root, ".pidgen"), { recursive: true });
    await writeFile(join(root, ".pidgen", "pidgen.toml"), "# mine\n");

    const refused = await json(ctx, "project", "setup", "STO", "--write");
    expect(refused.code).toBe(ExitCode.Refused);
    expect(refused.body.error?.code).toBe("FILES_EXIST");
    // Every file the write would create or replace in the existing .pidgen/, the differing one first.
    expect(refused.body.error?.details["paths"]).toEqual([
      ".pidgen/pidgen.toml",
      ".pidgen/scripts/activate",
      ".pidgen/scripts/provision",
      ".pidgen/scripts/teardown",
      ".pidgen/scripts/test",
    ]);
    expect(await readFile(join(root, ".pidgen", "pidgen.toml"), "utf8")).toBe("# mine\n");
    await expect(lstat(join(root, ".pidgen", "scripts"))).rejects.toThrow();

    const forced = await json(ctx, "project", "setup", "STO", "--write", "--force");
    expect(forced.code).toBe(ExitCode.Ok);
    const files = (forced.body.data as { files: Array<{ path: string; status: string }> }).files;
    expect(files[0]).toMatchObject({ path: ".pidgen/pidgen.toml", status: "updated" });
    expect(await readFile(join(root, ".pidgen", "pidgen.toml"), "utf8")).toContain("[tests]");
  });

  // AC-d23833d85997: exactly the proposed files, each with its mode, and an existing .pidgen/ is
  // changed only with --force.
  it("--write writes exactly the archive's files under .pidgen/, each 0644 or 0755 as proposed", async () => {
    const archive = tarGz([
      { name: ".pidgen/", type: "5", mode: 0o755 },
      { name: ".pidgen/pidgen.toml", mode: 0o664, content: "[tests]\n" },
      { name: ".pidgen/scripts/provision", mode: 0o775, content: "#!/bin/sh\n" },
      { name: ".pidgen/scripts/notes.md", mode: 0o600, content: "notes\n" },
    ]);
    const { ctx } = await setup(() => gzipResponse(archive));
    const root = await checkout(ctx);
    const { code } = await json(ctx, "project", "setup", "STO", "--write");
    expect(code).toBe(ExitCode.Ok);
    const written: Record<string, number> = {};
    for (const entry of await readdir(join(root, ".pidgen"), { recursive: true })) {
      const found = await lstat(join(root, ".pidgen", entry));
      if (found.isFile()) written[`.pidgen/${entry}`] = found.mode & 0o777;
    }
    expect(written).toEqual({
      ".pidgen/pidgen.toml": 0o644,
      ".pidgen/scripts/provision": 0o755,
      ".pidgen/scripts/notes.md": 0o644,
    });
    expect(await readFile(join(root, ".pidgen", "scripts", "notes.md"), "utf8")).toBe("notes\n");
    // Nothing outside .pidgen/ was touched.
    expect((await readdir(root)).sort()).toEqual([".git", ".pidgen", "src"]);
  });

  it.each<[string, (root: string) => Promise<void>, string[]]>([
    [
      "holds only a file of its own",
      async (root) => {
        await mkdir(join(root, ".pidgen"));
        await writeFile(join(root, ".pidgen", "local.toml"), "# mine\n");
      },
      [
        ".pidgen/pidgen.toml",
        ".pidgen/scripts/activate",
        ".pidgen/scripts/provision",
        ".pidgen/scripts/teardown",
        ".pidgen/scripts/test",
      ],
    ],
    [
      "holds a proposed script without its executable bit",
      async (root) => {
        await mkdir(join(root, ".pidgen", "scripts"), { recursive: true });
        const archive = await archiveFixture();
        const { readTarGz } = await import("../../src/core/tar.js");
        for (const file of readTarGz(archive).files) {
          await mkdir(join(root, file.path, ".."), { recursive: true });
          await writeFile(join(root, file.path), file.content);
          await chmod(join(root, file.path), file.mode & 0o111 ? 0o755 : 0o644);
        }
        await chmod(join(root, ".pidgen", "scripts", "test"), 0o644);
      },
      [".pidgen/scripts/test"],
    ],
  ])(
    "--write refuses to change an existing .pidgen/ that %s (FILES_EXIST, exit 5) unless --force",
    async (_, prepare, paths) => {
      const archive = await archiveFixture();
      const { ctx } = await setup(() => gzipResponse(archive));
      const root = await checkout(ctx);
      await prepare(root);
      const before = await readdir(join(root, ".pidgen"), { recursive: true });

      const refused = await json(ctx, "project", "setup", "STO", "--write");
      expect(refused.code).toBe(ExitCode.Refused);
      expect(refused.body.error?.code).toBe("FILES_EXIST");
      expect(refused.body.error?.details["paths"]).toEqual(paths);
      expect(refused.body.error?.details["next"]).toBe("pidgen project setup STO --write --force");
      expect((await readdir(join(root, ".pidgen"), { recursive: true })).sort()).toEqual(
        before.sort(),
      );

      const forced = await json(ctx, "project", "setup", "STO", "--write", "--force");
      expect(forced.code).toBe(ExitCode.Ok);
      expect((await stat(join(root, ".pidgen", "scripts", "test"))).mode & 0o777).toBe(0o755);
    },
  );

  it.each<[string, Entry[]]>([
    ["a path outside .pidgen/", [{ name: "Makefile", content: "all:\n" }]],
    ["a path climbing out", [{ name: ".pidgen/../../escape", content: "x" }]],
    ["an absolute path", [{ name: "/tmp/.pidgen/escape", content: "x" }]],
    ["a symbolic link", [{ name: ".pidgen/link", type: "2", linkname: "/etc/passwd" }]],
    ["a hard link", [{ name: ".pidgen/link", type: "1", linkname: ".pidgen/pidgen.toml" }]],
  ])(
    "--write refuses an archive with %s (ARCHIVE_INVALID, exit 1), writing nothing",
    async (_, entries) => {
      const archive = tarGz([{ name: ".pidgen/pidgen.toml", content: "[tests]\n" }, ...entries]);
      const { ctx } = await setup(() => gzipResponse(archive));
      const root = await checkout(ctx);
      const { code, body } = await json(ctx, "project", "setup", "STO", "--write");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error?.code).toBe("ARCHIVE_INVALID");
      await expect(lstat(join(root, ".pidgen"))).rejects.toThrow();
    },
  );

  it("--write refuses an answer that is not a gzip archive (ARCHIVE_INVALID, exit 1)", async () => {
    const { ctx } = await setup(() => gzipResponse(new TextEncoder().encode("not gzip")));
    await checkout(ctx);
    const { code, body } = await json(ctx, "project", "setup", "STO", "--write");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("ARCHIVE_INVALID");
  });

  it("--write outside a git checkout is NOT_A_CHECKOUT (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup(() => gzipResponse(new Uint8Array()));
    // An empty .git directory above is not a checkout, as git sees it.
    await mkdir(join(ctx.homeDir, ".git"));
    ctx.cwd = join(ctx.homeDir, "elsewhere");
    await mkdir(ctx.cwd);
    const { code, body } = await json(ctx, "project", "setup", "STO", "--write");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("NOT_A_CHECKOUT");
    expect(calls).toHaveLength(0);
  });

  it("--write keeps the server's refusal: READINESS_PROPOSAL_NOT_FOUND exits 4", async () => {
    const { ctx } = await setup(() =>
      publicError(404, "READINESS_PROPOSAL_NOT_FOUND", "Storefront has no proposed setup yet."),
    );
    await checkout(ctx);
    const { code, body } = await json(ctx, "project", "setup", "STO", "--write");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({
      code: "READINESS_PROPOSAL_NOT_FOUND",
      message: "Storefront has no proposed setup yet.",
    });
  });

  it("--pull-request posts /readiness/proposal/pull-request and returns the proposal with its pull request", async () => {
    const opened = await fixture("pull-request.json");
    const { ctx, calls } = await setup(() => ok(opened));
    const { code, body } = await json(ctx, "project", "setup", "STO", "--pull-request");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(opened);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/proposal/pull-request` });

    const human = await table(ctx, "project", "setup", "STO", "--pull-request");
    expect(human.text).toContain("Pull request #1");
    expect(human.text).toContain("https://forge.example.com/example-org/storefront/pulls/1");
    expect(human.text).toContain("pidgen project rehearse STO");
  });

  it("--pull-request keeps the server's refusal: FORGE_NOT_CONNECTED exits 5", async () => {
    const { ctx } = await setup(() =>
      publicError(409, "FORGE_NOT_CONNECTED", "Storefront has no forge connection."),
    );
    const { code, body } = await json(ctx, "project", "setup", "STO", "--pull-request");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("FORGE_NOT_CONNECTED");
  });

  it("--write with --pull-request, or --force without --write, is CLI_USAGE (exit 2)", async () => {
    const { ctx, calls } = await setup(() => ok({}));
    await checkout(ctx);
    for (const flags of [["--write", "--pull-request"], ["--force"]]) {
      const { code, body } = await json(ctx, "project", "setup", "STO", ...flags);
      expect(code, flags.join(" ")).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen project rehearse", () => {
  /** The POST answers `queued`; each later GET answers the next readiness in `states`. */
  async function rehearsal(states: string[]) {
    const findings = await fixture<Record<string, unknown>>("findings.json");
    const queued = await fixture("rehearsal-queued.json");
    const readiness = await Promise.all(
      states.map(async (name) => ({ ...findings, rehearsal: await fixture(name) })),
    );
    return setup((call, index) => {
      if (call.method === "POST") return ok(queued, 202);
      return ok(readiness[Math.min(index - 1, readiness.length - 1)]);
    });
  }

  it("prints each step as it is reported and the verdict last", async () => {
    const { ctx, calls } = await rehearsal([
      "rehearsal-queued.json",
      "rehearsal-running.json",
      "rehearsal-running.json",
      "rehearsal-passed.json",
    ]);
    ctx.io.stdoutIsTTY = true;
    ctx.out.length = 0;
    const code = await runCli(["project", "rehearse", "STO", "--format", "table"], ctx);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/rehearse` });
    expect(calls[0]!.body).toEqual({});
    expect(calls.slice(1).every((call) => call.method === "GET" && call.url === BASE)).toBe(true);
    expect(calls).toHaveLength(5);

    // One write per step, as each is reported, then the verdict.
    const writes = ctx.out.map((text) => text.trim()).filter((text) => text !== "");
    const steps = ["provision", "activate", "database", "tests"];
    const stepWrites = writes.filter((text) => steps.some((step) => text.startsWith(step)));
    expect(stepWrites.map((text) => text.split(/\s+/)[0])).toEqual(steps);
    expect(stepWrites[0]).toMatch(/^provision\s+passed\s+2:41/);
    expect(stepWrites[3]).toMatch(/^tests\s+passed\s+3:12\s+212 passed/);
    // The provision step is printed once, when first reported, though it was read three times.
    expect(writes.filter((text) => text.startsWith("provision"))).toHaveLength(1);
    const last = writes.at(-1)!;
    expect(last).toContain("Rehearsal passed");
    expect(last).toContain(
      "The setup works: provision 2:41, activate 0:01, database 0:09 and tests 3:12 with 212 passed on build-box.",
    );
    expect(writes.indexOf(last)).toBeGreaterThan(writes.indexOf(stepWrites[3]!));
  });

  it("with JSON prints one envelope with the settled rehearsal, its steps on stderr only on a terminal", async () => {
    const passed = await fixture("rehearsal-passed.json");
    const { ctx } = await rehearsal(["rehearsal-running.json", "rehearsal-passed.json"]);
    const { code, body } = await json(ctx, "project", "rehearse", "STO");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(passed);
    expect(ctx.err.join("")).toBe("");

    const terminal = await rehearsal(["rehearsal-running.json", "rehearsal-passed.json"]);
    terminal.ctx.io.interactive = true;
    const again = await json(terminal.ctx, "project", "rehearse", "STO");
    expect(again.body.data).toEqual(passed);
    const progress = terminal.ctx.err.join("");
    expect(progress).toMatch(/provision\s+passed/);
    expect(progress.indexOf("provision")).toBeLessThan(progress.indexOf("tests"));
  });

  it("--ref sends the branch, and --no-follow returns the queued rehearsal without reading again", async () => {
    const queued = await fixture("rehearsal-queued.json");
    const { ctx, calls } = await rehearsal(["rehearsal-passed.json"]);
    const { code, body } = await json(
      ctx,
      "project",
      "rehearse",
      "STO",
      "--ref",
      "pidgen/setup",
      "--no-follow",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(queued);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ ref: "pidgen/setup" });
  });

  it("a failed rehearsal exits 1 with REHEARSAL_FAILED, the failing step printed and the verdict last", async () => {
    const failed = await fixture("rehearsal-failed.json");
    const { ctx } = await rehearsal(["rehearsal-running.json", "rehearsal-failed.json"]);
    const { code, body } = await json(ctx, "project", "rehearse", "STO");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("REHEARSAL_FAILED");
    expect(body.error?.details["rehearsal"]).toEqual(failed);

    const human = await rehearsal(["rehearsal-running.json", "rehearsal-failed.json"]);
    const { code: tableCode, text } = await table(human.ctx, "project", "rehearse", "STO");
    expect(tableCode).toBe(ExitCode.Unexpected);
    expect(text).toMatch(
      /database\s+failed\s+0:07\s+exit 1\s+migration 0042 needs the pgvector extension/,
    );
    const verdict = text.lastIndexOf("Rehearsal failed");
    expect(verdict).toBeGreaterThan(text.indexOf("database"));
    expect(text.slice(verdict)).toContain("Change the image in compose.yaml");
  });

  it("a rehearsal still running after 30 minutes exits 8 with TIMEOUT, and one replaced exits 1", async () => {
    const running = await fixture("rehearsal-running.json");
    const { ctx } = await rehearsal(["rehearsal-running.json"]);
    const timedOut = await json(ctx, "project", "rehearse", "STO");
    expect(timedOut.code).toBe(ExitCode.Network);
    expect(timedOut.body.error?.code).toBe("TIMEOUT");
    expect(timedOut.body.error?.details).toMatchObject({
      rehearsal: running,
      next: "pidgen project inspect STO",
    });
    expect(ctx.now()).toBeGreaterThanOrEqual(30 * 60 * 1000);

    const findings = await fixture<Record<string, unknown>>("findings.json");
    const replaced = await setup((call) =>
      call.method === "POST"
        ? ok({ ...running, rehearsal_id: "reh-example-0", state: "queued", steps: [] }, 202)
        : ok({ ...findings, rehearsal: running }),
    );
    const superseded = await json(replaced.ctx, "project", "rehearse", "STO");
    expect(superseded.code).toBe(ExitCode.Unexpected);
    expect(superseded.body.error?.code).toBe("REHEARSAL_SUPERSEDED");
  }, 30_000);

  it("keeps the server's refusal: REHEARSAL_IN_PROGRESS exits 5", async () => {
    const { ctx, calls } = await setup(() =>
      publicError(409, "REHEARSAL_IN_PROGRESS", "A rehearsal of Storefront is already running."),
    );
    const { code, body } = await json(ctx, "project", "rehearse", "STO");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("REHEARSAL_IN_PROGRESS");
    expect(calls).toHaveLength(1);
  });

  it("a missing key, or an empty --ref, is CLI_USAGE (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup(() => ok({}));
    for (const argv of [
      ["project", "rehearse"],
      ["project", "rehearse", "STO", "--ref", " "],
    ]) {
      const { code, body } = await json(ctx, ...argv);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
    }
    expect(calls).toHaveLength(0);
  });
});

// AC-9f7dca84dddc: `pidgen project doctor` posts /readiness/doctor and prints the wireframe's CLI
// transcript (docs/public/wireframes/project-readiness/index.html in the server repository, the
// "In the terminal" overlay): the frame's title, one line per group with the failures beneath,
// then the verdict line, its sentence and the fix. `--json` prints the server's data unchanged.
describe("pidgen project doctor", () => {
  /** Every POST /readiness/doctor answers the fixture `name`. */
  async function doctor(name: string) {
    const report = await fixture(name);
    const harness = await setup(() => ok(report));
    return { ...harness, report };
  }

  it("posts /projects/{key}/readiness/doctor and prints the verdict, the six groups, the failures by Ticket key and the fix", async () => {
    const { ctx, calls } = await doctor("doctor-setup.json");
    const { code, text } = await table(ctx, "project", "doctor", "STO");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/doctor` });
    expect(calls[0]!.body).toEqual({});
    // The setup is the problem: exit 1.
    expect(code).toBe(ExitCode.Unexpected);
    expect(text).toBe(
      [
        "┌  Pidgen project doctor · Storefront (STO)",
        "│",
        "◇  Setup files on main · .pidgen/pidgen.toml at 7c1e0f2, 4 hooks, [tests] and [worker] set",
        "◇  Workers · ada-mbp meets uv >= 0.4, node >= 22, docker >= 24 (the only one that does)",
        "◇  Secrets · STRIPE_TEST_KEY set",
        "■  Workspaces, 7 days · 5 of 6 failures are activate exiting 1",
        '│  "uv.lock changed since provision; run provision" — STO-33, STO-34, STO-35, STO-36, STO-37',
        "│  .pidgen/scripts/activate was changed on 14 Oct by STO-30 to fail when the lockfile hash differs.",
        "│  activate must not fail on something a Ticket changes: warn on stderr and exit 0.",
        "◇  Tests, 7 days · 1 failure was code, not environment (STO-32)",
        "▲  Drift · main is 23 commits past the last rehearsal (1 Oct) · 1 leaked Compose project on ada-mbp (STO-29)",
        "│",
        "└  The setup is the problem.",
        "   5 of the 6 runs that failed since 11 Oct stopped before any test ran: activate exits 1 whenever uv.lock differs from what provision installed. STO-31 changed uv.lock on 15 Oct, and every workspace built since fails the same way.",
        '   Fix:   pidgen project doctor STO --propose-fix  # opens a pull request: "activate: warn instead of failing when uv.lock changes"',
        "   Then:  pidgen ticket act STO-33 retry_run       # and STO-34, STO-35, STO-36, STO-37, once the fix is on main",
        "   Also:  pidgen project rehearse STO              # refresh the timings from main (about 6 min)",
        "",
      ].join("\n"),
    );
  });

  it("says when the setup is not the problem, names the failed Tickets, and exits 0", async () => {
    const { ctx } = await doctor("doctor-code.json");
    const { code, text } = await table(ctx, "project", "doctor", "STO");
    expect(code).toBe(ExitCode.Ok);
    const lines = text.split("\n");
    expect(lines[0]).toBe("┌  Pidgen project doctor · Storefront (STO)");
    // The six groups, in order, each one line, the needs-you drift marked ▲.
    expect(
      lines.filter((line) => /^[◇▲■] {2}/.test(line)).map((line) => line.split(" · ")[0]),
    ).toEqual([
      "◇  Setup files on main",
      "◇  Workers",
      "◇  Secrets",
      "◇  Workspaces, 7 days",
      "◇  Tests, 7 days",
      "▲  Drift",
    ]);
    expect(text).toContain(
      [
        "└  The setup is not the problem.",
        "   2 runs failed since 11 Oct, both on assertions in tests the Ticket itself changed (STO-40, STO-41). Every workspace built since 1 Oct provisioned and activated, and the tests ran in 3:05 to 3:40.",
        "   Open:  pidgen ticket show STO-40    # and STO-41",
        "   Also:  pidgen project rehearse STO  # refresh the timings from main (about 6 min)",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("Fix:");
  });

  // AC-2cc4475ac8f5: exit 1 only when the verdict is setup; code and unclear exit 0, in every
  // output form.
  it.each([
    ["setup", "doctor-setup.json", ExitCode.Unexpected],
    ["code", "doctor-code.json", ExitCode.Ok],
    ["unclear", "doctor-unclear.json", ExitCode.Ok],
  ] as const)(
    "the verdict %s (%s) exits %i, in table, JSON and --json",
    async (verdict, name, exit) => {
      for (const argv of [["--format", "table"], ["--format", "json"], ["--json"], []]) {
        const { ctx, report } = await doctor(name);
        expect(report["verdict"]).toBe(verdict);
        ctx.io.stdoutIsTTY = true;
        const code = await runCli(["project", "doctor", "STO", ...argv], ctx);
        expect(code, argv.join(" ")).toBe(exit);
      }
    },
  );

  it("an unclear verdict says the doctor cannot tell, and names the Tickets to open", async () => {
    const { ctx } = await doctor("doctor-unclear.json");
    const { code, text } = await table(ctx, "project", "doctor", "STO");
    expect(code).toBe(ExitCode.Ok);
    expect(text).toContain("▲  Tests, 7 days · 1 failure the doctor cannot classify (STO-42)");
    expect(text).toContain(
      [
        "└  The doctor cannot tell whether the setup is the problem.",
        "   1 run failed since 11 Oct and the doctor cannot tell why: STO-42 stopped in its tests on a connection refused to localhost:6379, which neither the setup nor the Ticket's changes explain. Every other workspace built since 1 Oct provisioned and activated.",
        "   Open:  pidgen ticket show STO-42",
      ].join("\n"),
    );
    expect(text).not.toContain("The setup is not the problem.");
    expect(text).not.toContain("Fix:");
  });

  it("--propose-fix prints the opened pull request's URL in every output form", async () => {
    const url = "https://forge.example.com/acme/storefront/pulls/19";
    const human = await doctor("doctor-fix-proposed.json");
    const { text } = await table(human.ctx, "project", "doctor", "STO", "--propose-fix");
    expect(text).toContain(url);
    const raw = await doctor("doctor-fix-proposed.json");
    raw.ctx.out.length = 0;
    await runCli(["project", "doctor", "STO", "--propose-fix", "--json"], raw.ctx);
    expect(JSON.parse(raw.ctx.out.join(""))["fix"]["pull_request"]["url"]).toBe(url);
  });

  it("--json prints the server's data unchanged, and still exits 1 when the setup is the problem", async () => {
    for (const [name, exit] of [
      ["doctor-setup.json", ExitCode.Unexpected],
      ["doctor-code.json", ExitCode.Ok],
    ] as const) {
      const { ctx, report } = await doctor(name);
      ctx.io.stdoutIsTTY = true;
      ctx.out.length = 0;
      const code = await runCli(["project", "doctor", "STO", "--json"], ctx);
      expect(code, name).toBe(exit);
      expect(ctx.out, name).toHaveLength(1);
      expect(JSON.parse(ctx.out[0]!), name).toEqual(report);
    }
  });

  it("with --format json the report is the envelope's data, or SETUP_IS_THE_PROBLEM's details.report", async () => {
    const healthy = await doctor("doctor-code.json");
    const passed = await json(healthy.ctx, "project", "doctor", "STO");
    expect(passed.code).toBe(ExitCode.Ok);
    expect(passed.body.data).toEqual(healthy.report);
    expect(passed.body.meta["request_id"]).toBe("req_fake_readiness");

    const broken = await doctor("doctor-setup.json");
    const failed = await json(broken.ctx, "project", "doctor", "STO");
    expect(failed.code).toBe(ExitCode.Unexpected);
    expect(failed.body.error?.code).toBe("SETUP_IS_THE_PROBLEM");
    expect(failed.body.error?.message).toContain("5 of the 6 runs that failed since 11 Oct");
    expect(failed.body.error?.details["report"]).toEqual(broken.report);
  });

  it("--since sends the window in days, and --propose-fix asks for the pull request and shows it", async () => {
    const { ctx, calls } = await doctor("doctor-fix-proposed.json");
    const { code, text } = await table(
      ctx,
      "project",
      "doctor",
      "STO",
      "--since",
      "14d",
      "--propose-fix",
    );
    expect(code).toBe(ExitCode.Unexpected);
    expect(calls[0]!.body).toEqual({ since_days: 14, propose_fix: true });
    expect(text).toContain(
      "   Fix:   pull request #19 (open), https://forge.example.com/acme/storefront/pulls/19  # merge it",
    );
    expect(text).toContain("   Then:  pidgen ticket act STO-33 retry_run");

    const weeks = await doctor("doctor-code.json");
    await json(weeks.ctx, "project", "doctor", "STO", "--since", "2w");
    expect(weeks.calls[0]!.body).toEqual({ since_days: 14 });
  });

  it("--propose-fix without a template says no pull request was opened", async () => {
    const report = await fixture<Record<string, Record<string, unknown>>>("doctor-setup.json");
    const { ctx } = await setup(() => ok({ ...report, fix: { ...report["fix"], template: null } }));
    const { code, text } = await table(ctx, "project", "doctor", "STO", "--propose-fix");
    expect(code).toBe(ExitCode.Unexpected);
    expect(text).toContain(
      "   Fix:   activate: warn instead of failing when uv.lock changes  # no pull request: the doctor has no template for this fix",
    );
  });

  it("a missing key or a --since that is not 1 to 90 days is CLI_USAGE (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup(() => ok({}));
    for (const argv of [
      ["project", "doctor"],
      ["project", "doctor", "STO", "--since", "0d"],
      ["project", "doctor", "STO", "--since", "91d"],
      ["project", "doctor", "STO", "--since", "7x"],
      ["project", "doctor", "STO", "--since", "yesterday"],
    ]) {
      const { code, body } = await json(ctx, ...argv);
      expect(code, argv.join(" ")).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
    }
    expect(calls).toHaveLength(0);
  });

  it("keeps the server's refusal (PROJECT_NOT_FOUND exits 4), in JSON under --json", async () => {
    const { ctx } = await setup(() => publicError(404, "PROJECT_NOT_FOUND", "No project STO."));
    ctx.io.stdoutIsTTY = true;
    ctx.out.length = 0;
    const code = await runCli(["project", "doctor", "STO", "--json"], ctx);
    expect(code).toBe(ExitCode.NotFound);
    expect((envelope(ctx) as unknown as Body).error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("an answer that does not match the contract is UNEXPECTED_RESPONSE (exit 1)", async () => {
    const report = await fixture("doctor-setup.json");
    const { ctx } = await setup(() => ok({ ...report, verdict: "maybe" }));
    const { code, body } = await json(ctx, "project", "doctor", "STO");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });
});

// AC-62515192837a: each command prints a human table by default on a terminal and the server's
// `data` with --format json; a refusal keeps the server's code and the documented exit (3 authz,
// 4 not found, 5 refused).
describe("the readiness commands' output and refusals", () => {
  const COMMANDS = [
    ["project", "inspect", "STO"],
    ["project", "setup", "STO"],
    ["project", "setup", "STO", "--pull-request"],
    ["project", "setup", "STO", "--write"],
    ["project", "rehearse", "STO", "--no-follow"],
    ["project", "doctor", "STO"],
  ];

  /** What the server answers each command with, and the `data` the CLI must print. */
  async function answer(argv: string[]): Promise<{ response: () => Response; data: unknown }> {
    const findings = await fixture<Record<string, unknown>>("findings.json");
    const [, command] = argv;
    if (argv.includes("--pull-request")) {
      const opened = await fixture("pull-request.json");
      return { response: () => ok(opened, 201), data: opened };
    }
    if (argv.includes("--write")) {
      const archive = await archiveFixture();
      return { response: () => gzipResponse(archive), data: undefined };
    }
    if (command === "setup") return { response: () => ok(findings), data: findings["proposal"] };
    if (command === "rehearse") {
      const queued = await fixture("rehearsal-queued.json");
      return { response: () => ok(queued, 202), data: queued };
    }
    if (command === "doctor") {
      const report = await fixture("doctor-code.json");
      return { response: () => ok(report), data: report };
    }
    return { response: () => ok(findings), data: findings };
  }

  it.each(COMMANDS.map((argv) => [argv.join(" "), argv]))(
    "%s prints a human table by default on a terminal, and the server's data with --format json",
    async (_, argv) => {
      const { response, data } = await answer(argv);
      const human = await setup(response);
      await checkout(human.ctx);
      human.ctx.io.stdoutIsTTY = true;
      const code = await runCli(argv, human.ctx);
      expect(code).toBe(ExitCode.Ok);
      const text = human.ctx.out.join("");
      expect(text.trim().length).toBeGreaterThan(0);
      expect(() => JSON.parse(text) as unknown).toThrow();
      expect(text).toContain("STO");

      const machine = await setup(response);
      await checkout(machine.ctx);
      const { code: jsonCode, body } = await json(machine.ctx, ...argv);
      expect(jsonCode).toBe(ExitCode.Ok);
      expect(body.ok).toBe(true);
      if (data !== undefined) expect(body.data).toEqual(data);
    },
  );

  it.each(
    COMMANDS.flatMap((argv) =>
      (
        [
          [403, "PROJECT_FORBIDDEN", ExitCode.Auth],
          [404, "PROJECT_NOT_FOUND", ExitCode.NotFound],
          [409, "READINESS_NO_PROPOSAL", ExitCode.Refused],
        ] as const
      ).map(([status, code, exit]) => [argv.join(" "), status, code, exit, argv] as const),
    ),
  )("%s keeps the server's %i %s and exits %i", async (_, status, code, exit, argv) => {
    const { ctx } = await setup(() => publicError(status, code, `Refused: ${code}.`));
    await checkout(ctx);
    const { code: exitCode, body } = await json(ctx, ...argv);
    expect(exitCode).toBe(exit);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code, message: `Refused: ${code}.` });
  });

  it("keeps the contract's refusal codes: READINESS_NO_FORGE and READINESS_NO_WORKER exit 5", async () => {
    for (const [argv, code] of [
      [["project", "setup", "STO", "--pull-request"], "READINESS_NO_FORGE"],
      [["project", "rehearse", "STO"], "READINESS_NO_WORKER"],
    ] as const) {
      const { ctx } = await setup(() => publicError(409, code, `${code}.`));
      const { code: exitCode, body } = await json(ctx, ...argv);
      expect(exitCode, code).toBe(ExitCode.Refused);
      expect(body.error?.code).toBe(code);
    }
  });
});
