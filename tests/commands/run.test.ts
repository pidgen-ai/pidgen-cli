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
  url: URL;
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

const META = {
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

function summary(attempt: number, overrides: Record<string, unknown> = {}) {
  return {
    workflow_run_id: `WFR-example-${attempt}`,
    logical_run_id: "WFR-example-1",
    attempt_number: attempt,
    workflow_name: "implementation",
    status: "failed",
    ticket_id: "TKT-example-2",
    session_id: "SES-example",
    started_at: `2026-09-2${attempt}T10:00:00Z`,
    ended_at: `2026-09-2${attempt}T11:00:00Z`,
    terminal_reason_code: "node_failed",
    liveness: {
      state: "live",
      quiescent_since: null,
      recovery_count: 0,
      recovery_limit: 3,
      cause: null,
    },
    parent_attempt_id: attempt > 1 ? `WFR-example-${attempt - 1}` : null,
    resume_requester: null,
    resume_reason: null,
    pass_count: 1,
    admission_block_reason: null,
    ...overrides,
  };
}

/** Newest first, as the server answers: attempt 3, then 2, then 1. */
const RUNS = [
  summary(3, {
    status: "running",
    ended_at: null,
    terminal_reason_code: null,
    parent_attempt_id: "WFR-example-2",
  }),
  summary(2),
  summary(1),
];

const STRANDED_RUN = {
  ...summary(2, {
    terminal_reason_code: "stranded",
    liveness: {
      state: "stranded",
      quiescent_since: null,
      recovery_count: 3,
      recovery_limit: 3,
      cause: null,
    },
  }),
  stranded_cause: "contract_uncovered",
  nodes: [
    {
      node_id: "implement",
      status: "failed",
      attempt_count: 2,
      latest_attempt: 2,
      started_at: "2026-09-22T10:05:00Z",
      ended_at: "2026-09-22T10:55:00Z",
    },
    {
      node_id: "plan",
      status: "completed",
      attempt_count: 1,
      latest_attempt: 1,
      started_at: "2026-09-22T10:00:00Z",
      ended_at: "2026-09-22T10:04:00Z",
    },
  ],
};

const NODE = {
  workflow_run_id: "WFR-example-2",
  node_id: "plan",
  status: "completed",
  attempts: [
    {
      attempt: 1,
      fan_out_key: null,
      pass_number: 1,
      status: "completed",
      started_at: "2026-09-22T10:00:00Z",
      ended_at: "2026-09-22T10:04:00Z",
      reused_from_run_id: null,
      output: null,
      error: null,
    },
  ],
  output: {
    value: { summary: "Three steps", steps: ["read", "write", "test"] },
    artifacts: [],
    evidence: [],
    output_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  },
};

function ok(data: unknown, requestId: string) {
  return jsonResponse(
    200,
    { status: "ok", data, meta: null },
    { "x-request-id": requestId, "pidgen-api-version": "1.0" },
  );
}

function publicError(status: number, code: string, message: string) {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details: null, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

/** Answers the run routes of the public API for ticket ALPHA-2 and run WFR-example-2. */
function server(call: Call): Response {
  const path = decodeURIComponent(call.url.pathname);
  if (call.method !== "GET") return publicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  const list = /^\/api\/v1\/tickets\/([^/]+)\/runs$/.exec(path);
  if (list) {
    if (list[1] === "ALPHA-2") return ok(RUNS, "req_fake_list");
    if (list[1] === "ALPHA-5") return ok([], "req_fake_empty");
    return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
  }
  const run = /^\/api\/v1\/runs\/([^/]+)(?:\/nodes\/([^/]+))?$/.exec(path);
  if (!run || run[1] !== "WFR-example-2") {
    return publicError(404, "RUN_NOT_FOUND", "No such run in the Account.");
  }
  if (run[2] === undefined) return ok(STRANDED_RUN, "req_fake_show");
  if (run[2] === "plan") return ok(NODE, "req_fake_node");
  return publicError(404, "NODE_NOT_FOUND", "The node has no attempt in the run.");
}

async function setup(options: { respond?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? server;
  const ctx = await testContext({
    fetch: (input, init) => {
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
  });
  await saveConfig(ctx, CONFIG);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

function expectAuthenticated(call: Call | undefined) {
  expect(call?.headers).toMatchObject({
    authorization: `Bearer ${TOKEN}`,
    "x-pidgen-account": "ACC-EXAMPLE",
  });
}

describe("pidgen run list", () => {
  it("list returns the ticket's runs newest first with GET /tickets/{ref}/runs", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "run", "list", "ALPHA-2");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: RUNS,
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    const attempts = (body.data as { attempt_number: number }[]).map((r) => r.attempt_number);
    expect(attempts).toEqual([3, 2, 1]);
    expect(calls.map((call) => [call.method, call.url.pathname, call.url.search])).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-2/runs", ""],
    ]);
    expectAuthenticated(calls[0]);
  });

  it("list of a ticket with no runs returns an empty array", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "run", "list", "ALPHA-5");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: [], error: null });
  });

  it("list encodes the ref as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok([], "req_fake_empty") });
    const { code } = await run(ctx, "run", "list", "a/b c");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => call.url.toString())).toEqual([
      `${SERVER}/api/v1/tickets/a%2Fb%20c/runs`,
    ]);
  });

  it("not found: list of an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "run", "list", "ALPHA-999");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "TICKET_NOT_FOUND",
        message: "No such Ticket in the Account.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
  });

  it("list refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not read this Ticket."),
    });
    const { code, body } = await run(ctx, "run", "list", "ALPHA-2");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["no ref", ["run", "list"]],
    ["an empty ref", ["run", "list", " "]],
    ["a .. ref", ["run", "list", ".."]],
    ["two refs", ["run", "list", "ALPHA-2", "ALPHA-3"]],
  ])("usage: list with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen run show", () => {
  it("show returns the run with its nodes, terminal reason and stranded state", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "run", "show", "WFR-example-2");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: STRANDED_RUN,
      error: null,
      meta: { ...META, request_id: "req_fake_show" },
    });
    expect(body.data).toMatchObject({
      terminal_reason_code: "stranded",
      stranded_cause: "contract_uncovered",
      liveness: { state: "stranded", recovery_count: 3, recovery_limit: 3 },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/runs/WFR-example-2"],
    ]);
    expectAuthenticated(calls[0]);
  });

  it("not found: show of an unknown run exits 4 with RUN_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "run", "show", "WFR-example-999");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "RUN_NOT_FOUND",
        message: "No such run in the Account.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
  });

  it("show refused by the server as invalid input (422) exits 2 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "INPUT_INVALID", "The request failed validation."),
    });
    const { code, body } = await run(ctx, "run", "show", "WFR-example-2");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
  });

  it.each([
    ["no run", ["run", "show"]],
    ["an empty run", ["run", "show", ""]],
    ["a . run", ["run", "show", "."]],
    ["two runs", ["run", "show", "WFR-example-1", "WFR-example-2"]],
  ])("usage: show with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen run node-output", () => {
  it("node-output returns one node's output with GET /runs/{run}/nodes/{node}", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "run", "node-output", "WFR-example-2", "plan");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: NODE,
      error: null,
      meta: { ...META, request_id: "req_fake_node" },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/runs/WFR-example-2/nodes/plan"],
    ]);
    expectAuthenticated(calls[0]);
  });

  it("node-output encodes the run and node as single path segments", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(NODE, "req_fake_node") });
    const { code } = await run(ctx, "run", "node-output", "WFR/1", "fan out");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => call.url.toString())).toEqual([
      `${SERVER}/api/v1/runs/WFR%2F1/nodes/fan%20out`,
    ]);
  });

  it("not found: node-output of an unknown run exits 4 with RUN_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "run", "node-output", "WFR-example-999", "plan");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "RUN_NOT_FOUND" } });
  });

  it("not found: node-output of a node with no attempt exits 4 with NODE_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "run", "node-output", "WFR-example-2", "deploy");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "NODE_NOT_FOUND",
        message: "The node has no attempt in the run.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
  });

  it("usage: node-output without a node exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "run", "node-output", "WFR-example-2");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(/node/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no arguments", ["run", "node-output"]],
    ["an empty node", ["run", "node-output", "WFR-example-2", " "]],
    ["a .. node", ["run", "node-output", "WFR-example-2", ".."]],
    ["an empty run", ["run", "node-output", "", "plan"]],
    ["three arguments", ["run", "node-output", "WFR-example-2", "plan", "extra"]],
  ])("usage: node-output with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: run list at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["run", "list", "ALPHA-2"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Runs (3 displayed)", "WFR-example-3", "running"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: run show at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["run", "show", "WFR-example-2"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Run", "Nodes (2 displayed)", "implement", "failed"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: run node-output at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["run", "node-output", "WFR-example-2", "plan"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of [
    "Node output",
    "Attempts (1 displayed)",
    "Output",
    "Artifacts (0 displayed)",
    "Evidence (0 displayed)",
    NODE.output.output_digest,
  ])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});
