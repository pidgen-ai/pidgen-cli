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

const TYPES = [
  {
    key: "bug",
    label: "Bug",
    workflow_name: "implementation",
    builtin: true,
    default: true,
    ticket_count: 3,
    version: 1,
  },
  {
    key: "research",
    label: "Research",
    workflow_name: "research",
    builtin: false,
    default: false,
    ticket_count: 0,
    version: 2,
  },
];

async function setup(options: { respond?: (call: Call) => Response; config?: Config | null } = {}) {
  const calls: Call[] = [];
  const respond =
    options.respond ??
    (() =>
      jsonResponse(
        200,
        { status: "ok", data: TYPES, meta: null },
        { "x-request-id": "req_fake_types", "pidgen-api-version": "1.0" },
      ));
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
          ticket_count: expect.any(Number),
        }),
      );
    }
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
