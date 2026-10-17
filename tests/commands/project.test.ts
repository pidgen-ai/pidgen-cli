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

const MERGE_POLICY = { mode: "manual" };

function project(id: string, prefix: string): Record<string, unknown> {
  return {
    id,
    account_id: "ACC-EXAMPLE",
    name: `${prefix} project`,
    slug: prefix.toLowerCase(),
    description: "",
    prefix,
    ticket_counter: 12,
    epic_counter: 1,
    repository_url: null,
    language: "typescript",
    build_system: "npm",
    conventions: [],
    workflow_defaults: {},
    supported_workflows: [],
    max_active_workspaces: 2,
    refresh_policy: "none",
    delivery_mode: "auto",
    forge_connection_id: null,
    forge_repository: null,
    forge_mode: "none",
    worktree_base: "main",
    workspace_manifest: "pidgen.yaml",
    auto_merge_enabled: false,
    merge_policy: MERGE_POLICY,
    created_at: "2026-01-01T00:00:00Z",
    last_validated_at: null,
    deleted_at: null,
    forge_connection: null,
    auto_merge_refusal: null,
    delivery: null,
    rollup: { tickets: 12 },
  };
}

const PROJECTS = [project("proj-example-a", "ALPHA"), project("proj-example-b", "BETA")];

function publicError(status: number, code: string, message: string) {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details: null, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

async function setup(options: { respond?: (call: Call) => Response; config?: Config | null } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? (() => jsonResponse(200, { status: "ok", data: PROJECTS }));
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

describe("pidgen project list", () => {
  it("list returns the Account's projects in data, with the server's meta", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        jsonResponse(
          200,
          { status: "ok", data: PROJECTS, meta: null },
          { "x-request-id": "req_fake_list", "pidgen-api-version": "1.0" },
        ),
    });
    const { code, body } = await run(ctx, "project", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: PROJECTS,
      error: null,
      meta: {
        request_id: "req_fake_list",
        api_version: "1.0",
        profile: "default",
        account: "ACC-EXAMPLE",
        cli_version: "0.0.0-test",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${SERVER}/api/v1/projects` });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("list returns an empty array when the Account has no projects", async () => {
    const { ctx } = await setup({ respond: () => jsonResponse(200, { status: "ok", data: [] }) });
    const { code, body } = await run(ctx, "project", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: [], error: null });
  });

  it("list uses the Account named with --account", async () => {
    const config: Config = {
      default_profile: "default",
      profiles: {
        default: {
          url: SERVER,
          default_account: "ACC-EXAMPLE",
          credentials: {
            "ACC-EXAMPLE": { kind: "pat", token: TOKEN },
            "ACC-OTHER": { kind: "pat", token: "pidgen_pat_fake_other" },
          },
        },
      },
    };
    const { ctx, calls } = await setup({ config });
    const { code, body } = await run(ctx, "--account", "ACC-OTHER", "project", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.meta).toMatchObject({ account: "ACC-OTHER" });
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer pidgen_pat_fake_other",
      "x-pidgen-account": "ACC-OTHER",
    });
  });

  it("list refused by the server (403 FORBIDDEN) keeps the code and exits 3", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not read projects."),
    });
    const { code, body } = await run(ctx, "project", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "FORBIDDEN",
        message: "The token may not read projects.",
        details: { status: 403, request_id: "req_fake_error" },
      },
    });
  });

  it("list with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "project", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: list with an extra argument exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "project", "list", "ALPHA");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen project show", () => {
  it("show returns one project with its merge policy", async () => {
    const one = PROJECTS[0];
    const { ctx, calls } = await setup({
      respond: () =>
        jsonResponse(200, { status: "ok", data: one, meta: null }, { "x-request-id": "req_fake" }),
    });
    const { code, body } = await run(ctx, "project", "show", "ALPHA");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      data: one,
      error: null,
      meta: { request_id: "req_fake", profile: "default", account: "ACC-EXAMPLE" },
    });
    expect(body.data).toMatchObject({ id: "proj-example-a", merge_policy: MERGE_POLICY });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${SERVER}/api/v1/projects/ALPHA` });
  });

  it("show sends the key as one encoded path segment", async () => {
    const { ctx, calls } = await setup({
      respond: () => jsonResponse(200, { status: "ok", data: PROJECTS[1] }),
    });
    const { code } = await run(ctx, "project", "show", "a/b c");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url).toBe(`${SERVER}/api/v1/projects/a%2Fb%20c`);
  });

  it("not found: an unknown project exits 4 with the server's PROJECT_NOT_FOUND", async () => {
    const { ctx, calls } = await setup({
      respond: () => publicError(404, "PROJECT_NOT_FOUND", "No such project in the Account."),
    });
    const { code, body } = await run(ctx, "project", "show", "NOPE");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "No such project in the Account.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SERVER}/api/v1/projects/NOPE`);
  });

  it("not found: a 404 without a code exits 4 with NOT_FOUND", async () => {
    const { ctx } = await setup({ respond: () => jsonResponse(404, { detail: "Not Found" }) });
    const { code, body } = await run(ctx, "project", "show", "NOPE");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("usage: show without a key exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "project", "show");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(/key/);
    expect(calls).toHaveLength(0);
  });

  it.each(["", " ", ".", ".."])(
    "usage: show with the key %j exits 2 and sends nothing",
    async (key) => {
      const { ctx, calls } = await setup();
      const { code, body } = await run(ctx, "project", "show", key);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: { code: "CLI_USAGE", details: { argument: "project key" } },
      });
      expect(calls).toHaveLength(0);
    },
  );

  it("usage: show with two keys exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "project", "show", "ALPHA", "BETA");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [project, list] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["project", "list"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Projects (2 displayed)", "ALPHA", "BETA", "Delivery mode", "auto"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [project, show, ALPHA] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({
      respond: () => jsonResponse(200, { status: "ok", data: PROJECTS[0] }),
    });
    ctx.io.stdoutColumns = columns;
    const argv = ["project", "show", "ALPHA"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Project", "ALPHA", "Merge policy", "Delivery"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);
