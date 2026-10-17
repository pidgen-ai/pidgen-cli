import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { emptyMeta, render, success } from "../../src/core/envelope.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { hashContent, readStamp } from "../../src/core/skills.js";
import { saveConfig } from "../../src/core/config.js";
import { contractDigest } from "../../src/core/contract.js";
import committed from "../../contracts/openapi.json" with { type: "json" };
import {
  envelope,
  expectMutationParity,
  jsonResponse,
  REPO_SKILLS_DIR,
  tempDir,
  testContext,
} from "../support/context.js";

async function withAgents(...markers: string[]) {
  const ctx = await testContext();
  for (const marker of markers) await mkdir(join(ctx.homeDir, marker), { recursive: true });
  return ctx;
}

type Row = { skill: string; dir: string; agents: string[]; action?: string; state?: string };

interface ContractReport {
  state: "same" | "different" | "unchecked";
  cli: { version: string; digest: string };
  server: { version: string | null; digest: string } | null;
  only_in_cli: string[];
  only_on_server: string[];
  reason: { code: string; message: string } | null;
}

async function run(ctx: Awaited<ReturnType<typeof testContext>>, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  return { code, body: envelope(ctx) as { ok: boolean; data: Row[] } };
}

async function status(ctx: Awaited<ReturnType<typeof testContext>>, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["skills", "status", ...argv], ctx);
  const body = envelope(ctx) as {
    ok: boolean;
    data: { skills: Row[]; contract: ContractReport };
    error: { code: string } | null;
  };
  return { code, body };
}

describe("pidgen skills install", () => {
  it("installs every bundled skill for the agents found, stamped", async () => {
    const ctx = await withAgents(".claude", ".codex");
    const { code, body } = await run(ctx, "skills", "install");
    expect(code).toBe(ExitCode.Ok);
    const dirs = new Set(body.data.map((row) => row.dir));
    expect(dirs).toEqual(
      new Set([join(ctx.homeDir, ".claude/skills"), join(ctx.homeDir, ".agents/skills")]),
    );
    expect(body.data.every((row) => row.action === "installed")).toBe(true);
    const skills = new Set(body.data.map((row) => row.skill));
    for (const name of [
      "pidgen-manage-contracts",
      "pidgen-manage-epics",
      "pidgen-file-ticket",
      "pidgen-decompose-plan",
      "pidgen-triage-requests",
    ]) {
      expect(skills, name).toContain(name);
    }
    await expect(
      readFile(join(ctx.homeDir, ".claude/skills/pidgen-manage-contracts/SKILL.md"), "utf8"),
    ).resolves.toMatch(/^---\nname: pidgen-manage-contracts\n/);
    await expect(
      readFile(join(ctx.homeDir, ".agents/skills/pidgen-triage-requests/SKILL.md"), "utf8"),
    ).resolves.toMatch(/^---\nname: pidgen-triage-requests\n/);

    const installed = await readFile(
      join(ctx.homeDir, ".claude/skills/pidgen-manage-epics/SKILL.md"),
      "utf8",
    );
    const bundled = await readFile(join(REPO_SKILLS_DIR, "pidgen-manage-epics/SKILL.md"), "utf8");
    const { version, hash, body: original } = readStamp(installed);
    expect(version).toBe("0.0.0-test");
    expect(hash).toBe(hashContent(bundled));
    expect(original).toBe(bundled);
  });

  it("groups agents that share a directory", async () => {
    const ctx = await withAgents(".codex", ".pi");
    const { body } = await run(ctx, "skills", "install");
    expect(new Set(body.data.map((row) => row.agents.join(",")))).toEqual(new Set(["codex,pi"]));
  });

  it("installs into the current repository with --scope project", async () => {
    const ctx = await withAgents(".claude");
    ctx.cwd = await tempDir();
    const { body } = await run(ctx, "skills", "install", "--agent", "claude", "--scope", "project");
    expect(body.data[0]?.dir).toBe(join(ctx.cwd, ".claude/skills"));
  });

  it("leaves current copies alone and skips edited ones unless --force", async () => {
    const ctx = await withAgents(".claude");
    await run(ctx, "skills", "install");
    const file = join(ctx.homeDir, ".claude/skills/pidgen-manage-epics/SKILL.md");
    await writeFile(file, (await readFile(file, "utf8")) + "\nmy note\n");

    const second = await run(ctx, "skills", "install");
    const actions = Object.fromEntries(second.body.data.map((row) => [row.skill, row.action]));
    expect(actions["pidgen-manage-epics"]).toBe("skipped_edited");
    expect(actions["pidgen-query-tickets"]).toBe("unchanged");

    const forced = await run(ctx, "skills", "install", "--force");
    expect(forced.body.data.find((row) => row.skill === "pidgen-manage-epics")?.action).toBe(
      "updated",
    );
    expect(await readFile(file, "utf8")).not.toContain("my note");
  });

  it("refuses when no agent is found and none is named", async () => {
    const ctx = await testContext();
    const { code, body } = await run(ctx, "skills", "install");
    expect(code).toBe(ExitCode.Usage);
    expect(body.ok).toBe(false);
  });

  it("rejects an unknown agent as a usage error", async () => {
    const ctx = await testContext();
    const { code } = await run(ctx, "skills", "install", "--agent", "vim");
    expect(code).toBe(ExitCode.Usage);
  });
});

describe("pidgen skills status", () => {
  it("reports missing, current, edited and stale copies", async () => {
    const bundledDir = await tempDir();
    await cp(REPO_SKILLS_DIR, bundledDir, { recursive: true });
    const ctx = await withAgents(".claude");
    ctx.bundledSkillsDir = bundledDir;

    let { body } = await status(ctx);
    expect(body.data.skills.every((row) => row.state === "missing")).toBe(true);

    await run(ctx, "skills", "install");
    ({ body } = await status(ctx));
    expect(body.data.skills.every((row) => row.state === "current")).toBe(true);

    const installed = join(ctx.homeDir, ".claude/skills/pidgen-manage-epics/SKILL.md");
    await writeFile(installed, (await readFile(installed, "utf8")) + "edit\n");
    const bundled = join(bundledDir, "pidgen-query-tickets/SKILL.md");
    await writeFile(bundled, (await readFile(bundled, "utf8")) + "newer guidance\n");

    ({ body } = await status(ctx));
    const states = Object.fromEntries(body.data.skills.map((row) => [row.skill, row.state]));
    expect(states["pidgen-manage-epics"]).toBe("edited");
    expect(states["pidgen-query-tickets"]).toBe("stale");
    expect(states["pidgen-unstick-ticket"]).toBe("current");
  });
});

describe("pidgen skills status: the CLI's contract against the server's", () => {
  const SERVER = "https://pidgen.example.com";
  type Doc = {
    info: { version: string };
    paths: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;
  const COMMITTED = committed as unknown as Doc;

  /** A context whose configured server answers `GET /api/v1/openapi.json` with `document`. */
  async function withServer(document: unknown, status = 200) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const ctx = await testContext({
      fetch: (input, init) => {
        requests.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return Promise.resolve(jsonResponse(status, document));
      },
    });
    await mkdir(join(ctx.homeDir, ".claude"), { recursive: true });
    await saveConfig(ctx, {
      default_profile: "default",
      profiles: {
        default: {
          url: SERVER,
          default_account: "ACC-EXAMPLE",
          credentials: { "ACC-EXAMPLE": { kind: "pat", token: "pidgen_pat_fake_token_for_tests" } },
        },
      },
    });
    return { ctx, requests };
  }

  /** The committed document with its keys in another order, as a server may serialise it. */
  function reordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reordered);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reordered(child)]),
    );
  }

  // AC-e9b2af44165c: qualifications do not change the successful exit, request or JSON payload.
  it.each([40, 80, 120])(
    "human contract qualifications preserve successful execution at width %s",
    async (columns) => {
      const server = structuredClone(COMMITTED);
      delete server.paths["/api/v1/tickets/{ticket_id}/history"];
      const { ctx, requests } = await withServer(server);
      ctx.io.stdoutColumns = columns;
      const json = await expectMutationParity(
        ctx,
        requests,
        ["skills", "status"],
        ["Skills status", "Contract differs", "GET /api/v1/tickets/{ticket_id}/history"],
      );
      expect(json).toMatchObject({ ok: true, data: { contract: { state: "different" } } });
      ctx.fetch = () => Promise.reject(new TypeError("fetch failed"));
      const unchecked = await expectMutationParity(
        ctx,
        [],
        ["skills", "status"],
        ["Skills status", "Contract unchecked", "NETWORK", "State: unchecked"],
      );
      expect(unchecked).toMatchObject({
        ok: true,
        data: { contract: { state: "unchecked", reason: { code: "NETWORK" } } },
      });
    },
  );

  it("a server document matching the CLI's contract reports no difference", async () => {
    const { ctx, requests } = await withServer(reordered(COMMITTED));
    const { code, body } = await status(ctx);
    expect(code).toBe(ExitCode.Ok);
    const digest = contractDigest(COMMITTED);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.data.contract).toEqual({
      state: "same",
      cli: { version: COMMITTED.info.version, digest },
      server: { version: COMMITTED.info.version, digest },
      only_in_cli: [],
      only_on_server: [],
      reason: null,
    });
    // The document is read from the configured server without a credential.
    expect(requests.map((request) => request.url)).toEqual([`${SERVER}/api/v1/openapi.json`]);
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[0]?.headers).not.toHaveProperty("x-pidgen-account");
  });

  it("a server document that differs from the CLI's contract reports the difference", async () => {
    const server = structuredClone(COMMITTED);
    server.info = { ...server.info, version: "1.1" };
    delete server.paths["/api/v1/tickets/{ticket_id}/history"];
    server.paths["/api/v1/example-only-on-server"] = { get: { responses: {} } };
    const { ctx } = await withServer(server);
    const { code, body } = await status(ctx);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data.contract).toEqual({
      state: "different",
      cli: { version: COMMITTED.info.version, digest: contractDigest(COMMITTED) },
      server: { version: "1.1", digest: contractDigest(server) },
      only_in_cli: ["GET /api/v1/tickets/{ticket_id}/history"],
      only_on_server: ["GET /api/v1/example-only-on-server"],
      reason: null,
    });
    expect(body.data.skills.length).toBeGreaterThan(0);
  });

  it("a difference only inside a schema, with the same version and routes, is a difference", async () => {
    const server = structuredClone(COMMITTED) as Doc & {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    delete server.components.schemas["EditTicketRequest"]!.properties["team_member_id"];
    const { ctx } = await withServer(server);
    const { body } = await status(ctx);
    expect(body.data.contract).toMatchObject({
      state: "different",
      server: { version: COMMITTED.info.version, digest: contractDigest(server) },
      only_in_cli: [],
      only_on_server: [],
    });
    expect(body.data.contract.server?.digest).not.toBe(contractDigest(COMMITTED));
  });

  it("with no server configured it reads the hosted server's contract", async () => {
    const requested: string[] = [];
    const ctx = await testContext({
      fetch: ((input: string | URL | Request) => {
        requested.push(String(input));
        return Promise.reject(new TypeError("fetch failed"));
      }) as typeof fetch,
    });
    await mkdir(join(ctx.homeDir, ".claude"), { recursive: true });
    const { code, body } = await status(ctx);
    expect(code).toBe(ExitCode.Ok);
    // An unreachable server is retried; every attempt goes to the hosted server's document.
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(requested)).toEqual(new Set(["https://api.pidgen.ai/api/v1/openapi.json"]));
    expect(body.data.contract).toMatchObject({
      state: "unchecked",
      cli: { version: COMMITTED.info.version, digest: contractDigest(COMMITTED) },
      server: null,
      reason: { code: "NETWORK" },
    });
  });

  it.each([
    ["an unreachable server", "NETWORK", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a server refusal",
      "NOT_FOUND",
      () =>
        Promise.resolve(
          jsonResponse(404, {
            status: "error",
            error: { code: "NOT_FOUND", message: "No such route.", request_id: "req_fake" },
          }),
        ),
    ],
    [
      "a body that is not an API document",
      "UNEXPECTED_RESPONSE",
      () => Promise.resolve(jsonResponse(200, { status: "ok", data: [] })),
    ],
  ])(
    "%s leaves the contract unchecked and still reports the skills",
    async (_, reason, respond) => {
      const ctx = await testContext({ fetch: respond as typeof fetch });
      await mkdir(join(ctx.homeDir, ".claude"), { recursive: true });
      ctx.env["PIDGEN_API_URL"] = SERVER;
      const { code, body } = await status(ctx);
      expect(code).toBe(ExitCode.Ok);
      expect(body.data.contract).toMatchObject({
        state: "unchecked",
        server: null,
        reason: { code: reason },
      });
      expect(body.data.skills.length).toBeGreaterThan(0);
    },
  );
});

// AC-41fb01e1808c, AC-4a3b49cb3f60
// These are the same result records returned by installSkills, without changing installation.
describe("skills installation presentation", () => {
  const present = (rows: Row[]) =>
    render(success(rows, emptyMeta()), "table", {
      command: ["skills", "install"],
      terminal: { isTTY: true, columns: 80 },
    });
  it("counts skills, destinations, agent coverage and records separately", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `skill-${i}`).flatMap((skill) => [
      { skill, dir: "/example/claude/skills", agents: ["claude"], action: "installed" },
      { skill, dir: "/example/shared/skills", agents: ["codex", "pi"], action: "installed" },
    ]);
    const output = present(rows);
    expect(output).toContain("10 distinct skills");
    expect(output).toContain("2 destinations");
    expect(output).toContain("3 agents");
    expect(output).toContain("20 skill-destination records");
    expect(output).toContain("20 installed");
    expect(output).toContain("/example/shared/skills (codex, pi)");
    for (const row of rows) expect(output).toContain(`${row.skill}: installed`);
  });
  it("reports every outcome per destination and preserves edited copies", () => {
    const rows = ["installed", "updated", "unchanged", "skipped_edited"].flatMap((action, i) => [
      { skill: `skill-${i}`, dir: "/example/one", agents: ["claude"], action },
      { skill: `skill-${i}`, dir: "/example/two", agents: ["codex", "pi"], action },
    ]);
    const output = present(rows);
    expect(output).toContain("8 skill-destination records");
    for (const action of ["installed", "updated", "unchanged", "skipped edited"])
      expect(output).toContain(`2 ${action}`);
    for (const dir of ["/example/one", "/example/two"]) {
      const section = output.slice(output.indexOf(dir)).split("\n\n")[0]!;
      rows
        .filter((row) => row.dir === dir)
        .forEach((row) =>
          expect(section).toContain(`${row.skill}: ${row.action!.replace("_", " ")}`),
        );
    }
    expect(output).toMatch(/locally edited copies.*preserved/i);
  });

  // AC-941bd4e2e23a: wrap prose while preserving skill/destination associations.
  it.each([40, 80, 120])("reflows installation summaries at %s columns", (columns) => {
    const dir = "/example/" + "directory with spaces/".repeat(8);
    const skill = "pidgen-" + "long-name-".repeat(15);
    const data = [{ skill, dir, agents: ["codex", "pi"], action: "skipped_edited" }];
    const output = render(success(data, emptyMeta()), "table", {
      command: ["skills", "install"],
      terminal: { isTTY: true, columns },
    });
    expect(output).toContain(dir);
    expect(output).toContain(skill);
    const prose = output.replace(/\s+/g, " ");
    expect(prose).toContain(
      "1 distinct skills, 1 destinations, 2 agents; 1 skill-destination records.",
    );
    expect(prose).toContain("Skipped locally edited copies were preserved.");
    for (const line of output.trimEnd().split("\n")) {
      if (!line.includes(dir) && !line.includes(skill))
        expect(line.length).toBeLessThanOrEqual(columns);
    }
  });
});
