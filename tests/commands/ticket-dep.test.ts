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
  body: unknown;
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

function edge(source: number, target: number, depType = "blocks") {
  return {
    id: `DEP-example-${source}-${target}`,
    account_id: "ACC-EXAMPLE",
    source_id: `TKT-example-${source}`,
    target_id: `TKT-example-${target}`,
    dep_type: depType,
    project_id: "proj-example-a",
    epic_id: null,
  };
}

function peer(number: number, depType = "blocks", stage = "ready") {
  return {
    id: `TKT-example-${number}`,
    ticket_key: `ALPHA-${number}`,
    title: `Ticket ${number}`,
    stage,
    dep_type: depType,
    edge_id: `DEP-example-${number}`,
  };
}

const DEPENDENCIES = {
  ticket_id: "TKT-example-2",
  ticket_key: "ALPHA-2",
  blocked_by: [peer(1, "blocks", "completed")],
  blocks: [peer(3), peer(4, "informs", "draft")],
  inherited_blocked_by: [
    {
      ...peer(5, "blocks", "in_execution"),
      declared_on_id: "TKT-example-9",
      declared_on_key: "ALPHA-9",
      declared_on_title: "Ticket 9",
    },
  ],
};

function ok(status: number, data: unknown, requestId = "req_fake_ok") {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": requestId, "pidgen-api-version": "1.0" },
  );
}

function publicError(status: number, code: string, message: string, details: unknown = null) {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

const number = (ref: string | null | undefined) => Number(/(\d+)$/.exec(ref ?? "")?.[1]);

/** Answers the ticket dependency routes of the public API for ALPHA-1 … ALPHA-9. */
function server(call: Call): Response {
  const path = decodeURIComponent(call.url.pathname);
  const route = /^\/api\/v1\/tickets\/([^/]+)\/dependencies(?:\/([^/]+))?$/.exec(path);
  const ticket = number(route?.[1]);
  if (!route || !(ticket >= 1 && ticket <= 9)) {
    return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
  }
  if (call.method === "GET" && route[2] === undefined) {
    return ok(200, DEPENDENCIES, "req_fake_list");
  }
  if (call.method === "POST" && route[2] === undefined) {
    const body = call.body as { source_id: string; dep_type?: string };
    const source = number(body.source_id);
    if (!(source >= 1 && source <= 9)) {
      return publicError(404, "DEPENDENCY_ENDPOINT_NOT_FOUND", "source_id names no Ticket.");
    }
    if (source === ticket) {
      return publicError(409, "DEPENDENCY_SELF_EDGE", "A ticket cannot depend on itself.");
    }
    return ok(201, edge(source, ticket, body.dep_type), "req_fake_add");
  }
  if (call.method === "DELETE" && route[2] !== undefined) {
    const source = number(route[2]);
    if (ticket === 2 && source === 1) {
      const type = call.url.searchParams.get("dep_type") ?? "blocks";
      return ok(200, edge(1, 2, type), "req_fake_rm");
    }
    return publicError(404, "DEPENDENCY_NOT_FOUND", "There is no such edge.");
  }
  return publicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
}

async function setup(options: { respond?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? server;
  const ctx = await testContext({
    fetch: (input, init) => {
      const text = init?.body;
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
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

const refusedCycle = () =>
  publicError(409, "DEPENDENCY_CYCLE", "The edge would close a cycle.", {
    cycle: ["TKT-example-1", "TKT-example-2", "TKT-example-1"],
  });

describe("pidgen ticket dep add", () => {
  it("add creates a blocks edge with POST /tickets/{ref}/dependencies and returns it", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "add", "ALPHA-2", "--on", "ALPHA-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: edge(1, 2),
      error: null,
      meta: { ...META, request_id: "req_fake_add" },
    });
    expect(body.data).toMatchObject({ dep_type: "blocks" });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["POST", "/api/v1/tickets/ALPHA-2/dependencies"],
    ]);
    expect(calls[0]?.body).toEqual({ source_id: "ALPHA-1" });
    expectAuthenticated(calls[0]);
  });

  it("add --type blocks sends dep_type blocks", async () => {
    const { ctx, calls } = await setup();
    const argv = ["ticket", "dep", "add", "ALPHA-2", "--on", "ALPHA-1", "--type", "blocks"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(edge(1, 2, "blocks"));
    expect(calls[0]?.body).toEqual({ source_id: "ALPHA-1", dep_type: "blocks" });
  });

  it("add --type informs sends dep_type informs", async () => {
    const { ctx, calls } = await setup();
    const argv = ["ticket", "dep", "add", "ALPHA-3", "--on", "ALPHA-2", "--type", "informs"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(edge(2, 3, "informs"));
    expect(calls[0]?.body).toEqual({ source_id: "ALPHA-2", dep_type: "informs" });
  });

  it("add percent-encodes the ref as one path segment", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "ticket", "dep", "add", "TKT/2", "--on", "ALPHA-1");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/TKT%2F2/dependencies");
  });

  it("add refused by the server as a cycle (409 DEPENDENCY_CYCLE) exits 5 with its code", async () => {
    const { ctx, calls } = await setup({ respond: refusedCycle });
    const { code, body } = await run(ctx, "ticket", "dep", "add", "ALPHA-1", "--on", "ALPHA-2");
    expect(code).toBe(ExitCode.Refused);
    expect(code).toBe(5);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "DEPENDENCY_CYCLE",
        message: "The edge would close a cycle.",
        details: {
          status: 409,
          request_id: "req_fake_error",
          cycle: ["TKT-example-1", "TKT-example-2", "TKT-example-1"],
        },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("add refused by the server as a self edge (409 DEPENDENCY_SELF_EDGE) exits 5 with its code", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "add", "ALPHA-2", "--on", "ALPHA-2");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DEPENDENCY_SELF_EDGE", details: { status: 409 } },
    });
  });

  it.each([
    ["DEPENDENCY_TARGET_FROZEN", "The target is at or past execution."],
    ["DEPENDENCY_CROSS_PROJECT", "The tickets are in different projects."],
  ])("add refused by the server with 409 %s exits 5 with its code", async (errorCode, message) => {
    const { ctx } = await setup({ respond: () => publicError(409, errorCode, message) });
    const { code, body } = await run(ctx, "ticket", "dep", "add", "ALPHA-2", "--on", "ALPHA-1");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: errorCode, message } });
  });

  it("add refused: an unknown prerequisite exits 4 with DEPENDENCY_ENDPOINT_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "add", "ALPHA-2", "--on", "ALPHA-99");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DEPENDENCY_ENDPOINT_NOT_FOUND", details: { status: 404 } },
    });
  });

  it("add refused: an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "add", "ALPHA-99", "--on", "ALPHA-1");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });

  it.each([
    ["without --on", ["ticket", "dep", "add", "ALPHA-2"]],
    ["with an empty --on", ["ticket", "dep", "add", "ALPHA-2", "--on", " "]],
    ["without a ref", ["ticket", "dep", "add", "--on", "ALPHA-1"]],
    ["with an empty ref", ["ticket", "dep", "add", " ", "--on", "ALPHA-1"]],
    ["with a .. ref", ["ticket", "dep", "add", "..", "--on", "ALPHA-1"]],
    ["with two refs", ["ticket", "dep", "add", "ALPHA-2", "ALPHA-3", "--on", "ALPHA-1"]],
    [
      "with an unknown --type",
      ["ticket", "dep", "add", "ALPHA-2", "--on", "ALPHA-1", "--type", "waits"],
    ],
    ["with an unknown verb", ["ticket", "dep", "link", "ALPHA-2", "--on", "ALPHA-1"]],
  ])("usage: dep add %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(code).toBe(2);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket dep list", () => {
  it("list returns edges in both directions from GET /tickets/{ref}/dependencies", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "list", "ALPHA-2");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: DEPENDENCIES,
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    expect(body.data).toMatchObject({
      blocked_by: [expect.objectContaining({ ticket_key: "ALPHA-1" })],
      blocks: [
        expect.objectContaining({ ticket_key: "ALPHA-3" }),
        expect.objectContaining({ ticket_key: "ALPHA-4", dep_type: "informs" }),
      ],
      inherited_blocked_by: [expect.objectContaining({ declared_on_key: "ALPHA-9" })],
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-2/dependencies"],
    ]);
    expect(calls[0]?.body).toBeUndefined();
    expectAuthenticated(calls[0]);
  });

  it("list refused: an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "list", "ALPHA-99");
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
    const { code, body } = await run(ctx, "ticket", "dep", "list", "ALPHA-2");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["no ref", ["ticket", "dep", "list"]],
    ["an empty ref", ["ticket", "dep", "list", " "]],
    ["a . ref", ["ticket", "dep", "list", "."]],
    ["two refs", ["ticket", "dep", "list", "ALPHA-2", "ALPHA-3"]],
  ])("usage: dep list with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket dep rm", () => {
  it("rm removes the edge with DELETE /tickets/{ref}/dependencies/{source} and returns it", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "rm", "ALPHA-2", "--on", "ALPHA-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: edge(1, 2),
      error: null,
      meta: { ...META, request_id: "req_fake_rm" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-2/dependencies/ALPHA-1");
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.body).toBeUndefined();
    expectAuthenticated(calls[0]);
  });

  it("rm --type sends dep_type as a query parameter", async () => {
    const { ctx, calls } = await setup();
    const argv = ["ticket", "dep", "rm", "ALPHA-2", "--on", "ALPHA-1", "--type", "informs"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(edge(1, 2, "informs"));
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ dep_type: "informs" });
  });

  it("rm percent-encodes --on as one path segment", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "ticket", "dep", "rm", "ALPHA-2", "--on", "TKT/1");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-2/dependencies/TKT%2F1");
  });

  it("rm refused: an edge that does not exist exits 4 with DEPENDENCY_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "dep", "rm", "ALPHA-3", "--on", "ALPHA-1");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DEPENDENCY_NOT_FOUND", details: { status: 404 } },
    });
  });

  it("rm refused by the server (409 DEPENDENCY_TARGET_FROZEN) exits 5 with its code", async () => {
    const { ctx } = await setup({
      respond: () =>
        publicError(409, "DEPENDENCY_TARGET_FROZEN", "The ticket is at or past execution."),
    });
    const { code, body } = await run(ctx, "ticket", "dep", "rm", "ALPHA-2", "--on", "ALPHA-1");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "DEPENDENCY_TARGET_FROZEN",
        message: "The ticket is at or past execution.",
        details: { status: 409 },
      },
    });
  });

  it.each([
    ["without --on", ["ticket", "dep", "rm", "ALPHA-2"]],
    ["with an empty --on", ["ticket", "dep", "rm", "ALPHA-2", "--on", ""]],
    ["with a .. --on", ["ticket", "dep", "rm", "ALPHA-2", "--on", ".."]],
    ["without a ref", ["ticket", "dep", "rm", "--on", "ALPHA-1"]],
    ["with a .. ref", ["ticket", "dep", "rm", "..", "--on", "ALPHA-1"]],
    [
      "with an unknown --type",
      ["ticket", "dep", "rm", "ALPHA-2", "--on", "ALPHA-1", "--type", "x"],
    ],
  ])("usage: dep rm %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [ticket, dep, list, ALPHA-2] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["ticket", "dep", "list", "ALPHA-2"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of [
      "Ticket dependencies",
      "Blocked by (1 displayed)",
      "Blocks (2 displayed)",
      "Inherited blocked by (1 displayed)",
      "ALPHA-9",
      "in_execution",
    ])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);
