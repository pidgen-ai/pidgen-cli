import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";

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
}

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

/** A When to use longer than any table gives it, so the table shortens it. */
const BUG_WHEN_TO_USE =
  "Something that worked, or was specified, no longer does. Name the steps, the expected result and the actual result, so the fix can be proved by a test that fails before it.";

const TYPES = [
  {
    key: "bug",
    label: "Bug",
    workflow_name: "implementation",
    builtin: true,
    default: true,
    ticket_count: 3,
    version: 1,
    when_to_use: BUG_WHEN_TO_USE,
    workflow_title: "Implementation",
  },
  {
    key: "research",
    label: "Research",
    workflow_name: "research",
    builtin: false,
    default: false,
    ticket_count: 0,
    version: 2,
    when_to_use: null,
    workflow_title: "Research and report",
  },
];

/** The same types as a server from before When to use answers them: without the two fields. */
const LEGACY_TYPES = TYPES.map((type) => {
  const legacy: Record<string, unknown> = { ...type };
  delete legacy["when_to_use"];
  delete legacy["workflow_title"];
  return legacy;
});

function answer(data: unknown) {
  return () =>
    jsonResponse(
      200,
      { status: "ok", data, meta: null },
      { "x-request-id": "req_fake_types", "pidgen-api-version": "1.0" },
    );
}

async function setup(options: { respond?: (call: Call) => Response; config?: Config | null } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? answer(TYPES);
  const ctx = await testContext({
    fetch: (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
  });
  const config = options.config === undefined ? CONFIG : options.config;
  if (config) await saveConfig(ctx, config);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("pidgen ticket types", () => {
  it("types returns each workflow type's key, label, workflow and ticket count", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: TYPES,
      error: null,
      meta: {
        request_id: "req_fake_types",
        api_version: "1.0",
        profile: "default",
        account: "ACC-EXAMPLE",
        cli_version: "0.0.0-test",
      },
    });
    for (const type of body.data as Record<string, unknown>[]) {
      expect(type).toEqual(
        expect.objectContaining({
          key: expect.any(String),
          label: expect.any(String),
          workflow_name: expect.any(String),
          workflow_title: expect.any(String),
          ticket_count: expect.any(Number),
        }),
      );
      expect(type).toHaveProperty("when_to_use");
    }
    // The full When to use, untruncated, and null for a type without one.
    expect((body.data as Record<string, unknown>[]).map((type) => type["when_to_use"])).toEqual([
      BUG_WHEN_TO_USE,
      null,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${SERVER}/api/v1/workflow-types` });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("types renders a table with --format table", async () => {
    const { ctx } = await setup();
    const code = await runCli(["--format", "table", "ticket", "types"], ctx);
    expect(code).toBe(ExitCode.Ok);
    const table = ctx.out.join("");
    expect(table).toContain("Workflow types (2 displayed)");
    for (const label of ["Key", "Label", "Workflow name", "Ticket count"])
      expect(table).toContain(label);
    expect(table).toContain("research");
  });

  it("types shows each type's When to use and workflow title in the table, When to use shortened", async () => {
    const { ctx } = await setup();
    ctx.io.stdoutColumns = 160;
    expect(await runCli(["--format", "table", "ticket", "types"], ctx)).toBe(ExitCode.Ok);
    const table = ctx.out.join("");
    const lines = table.split("\n");
    const header = lines.find((line) => line.startsWith("Key"))!;
    expect(header).toContain("Workflow title");
    expect(header).toMatch(/When to use$/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(160);
    const bug = lines.find((line) => line.startsWith("bug"))!;
    expect(bug).toContain("Implementation");
    // When to use is cut on the table's line, and ends with an ellipsis; JSON keeps it whole.
    expect(bug).toContain(BUG_WHEN_TO_USE.slice(0, 20));
    expect(bug).toMatch(/…$/);
    expect(table).not.toContain(BUG_WHEN_TO_USE);
    // A type without When to use shows nothing there, not "null".
    const research = lines.find((line) => line.startsWith("research"))!;
    expect(research).toContain("Research and report");
    expect(research).not.toContain("null");
    expect(research.trimEnd()).toBe(research);
    expect(research.length).toBeLessThan(header.length);
  });

  it("types at a narrow terminal lists each type with its When to use shortened", async () => {
    const { ctx } = await setup();
    ctx.io.stdoutColumns = 60;
    expect(await runCli(["--format", "table", "ticket", "types"], ctx)).toBe(ExitCode.Ok);
    const text = ctx.out.join("");
    expect(text).toContain("When to use:");
    expect(text).toContain("Workflow title: Research and report");
    expect(text).not.toContain(BUG_WHEN_TO_USE);
    expect(text).toContain("…");
    expect(text).not.toContain("null");
  });

  it("types from a server that does not send when_to_use or workflow_title reads them as null", async () => {
    const { ctx } = await setup({ respond: answer(LEGACY_TYPES) });
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      LEGACY_TYPES.map((type) => ({ ...type, when_to_use: null, workflow_title: null })),
    );
    ctx.out.length = 0;
    ctx.io.stdoutColumns = 160;
    expect(await runCli(["--format", "table", "ticket", "types"], ctx)).toBe(ExitCode.Ok);
    const table = ctx.out.join("");
    expect(table).toContain("When to use");
    expect(table).not.toContain("null");
  });

  it("types whose answer does not match the contract exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({
      respond: answer([{ ...TYPES[0], when_to_use: "x".repeat(601) }]),
    });
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "UNEXPECTED_RESPONSE", details: { route: "GET /api/v1/workflow-types" } },
    });
  });

  it("types refused by the server (503 SERVICE_UNAVAILABLE) keeps the code and exits 1", async () => {
    const { ctx } = await setup({
      respond: () =>
        jsonResponse(503, {
          status: "error",
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The App Service is not ready; retry.",
            details: null,
            request_id: "req_fake_error",
          },
        }),
    });
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "SERVICE_UNAVAILABLE",
        details: { status: 503, request_id: "req_fake_error" },
      },
    });
  });

  it("types refused for a missing credential (401) exits 3", async () => {
    const { ctx } = await setup({
      respond: () =>
        jsonResponse(401, {
          status: "error",
          error: { code: "AUTH_REQUIRED", message: "Sign in.", details: null, request_id: null },
        }),
    });
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
  });

  it("types with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "ticket", "types");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: types with an extra argument exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "types", "bug");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [ticket, types] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["ticket", "types"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Workflow types (2 displayed)", "bug", "Research", "Builtin", "Default"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);
