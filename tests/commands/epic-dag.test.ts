import { afterEach, describe, expect, it } from "vitest";
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

function node(number: number, depth: number, stage = "backlog") {
  return {
    id: `TKT-example-${number}`,
    ticket_key: `ALPHA-${number}`,
    title: `Ticket ${number}`,
    stage,
    status_label: stage,
    situation: null,
    depth,
    on_critical_path: false,
  };
}

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

const EDGES = [edge(1, 2), edge(2, 3, "informs")];

/** ALPHA-12 is an Epic: its graph is the ordinary dependency graph of the ticket. */
const GRAPH = {
  ticket_id: "TKT-example-12",
  ticket_key: "ALPHA-12",
  epic_id: "TKT-example-12",
  up: 2,
  down: 2,
  nodes: [node(12, 0), node(11, -1, "completed")],
  edges: [
    {
      source_id: "TKT-example-11",
      target_id: "TKT-example-12",
      dep_type: "blocks",
      edge_id: "DEP-example-11-12",
    },
  ],
  pieces: [
    {
      id: "TKT-example-1",
      ticket_key: "ALPHA-1",
      title: "Ticket 1",
      stage: "completed",
      status_label: "completed",
    },
    {
      id: "TKT-example-2",
      ticket_key: "ALPHA-2",
      title: "Ticket 2",
      stage: "backlog",
      status_label: "backlog",
    },
  ],
  piece_edges: [
    {
      source_id: "TKT-example-1",
      target_id: "TKT-example-2",
      dep_type: "blocks",
      edge_id: "DEP-example-1-2",
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

/** Answers the ticket dependency routes of the public API, and nothing else. */
function server(call: Call): Response {
  const path = call.url.pathname;
  if (path === "/api/v1/tickets/ALPHA-12/dependencies/graph" && call.method === "GET") {
    return ok(200, GRAPH, "req_fake_dag");
  }
  const add = /^\/api\/v1\/tickets\/([^/]+)\/dependencies$/.exec(path);
  if (add && call.method === "POST") {
    const body = call.body as { source_id: string; dep_type?: string };
    const target = decodeURIComponent(add[1] ?? "");
    if (body.source_id === target) {
      return publicError(409, "DEPENDENCY_SELF_EDGE", "A ticket cannot depend on itself.");
    }
    return ok(201, edge(number(body.source_id), number(target), body.dep_type), "req_fake_add");
  }
  const rm = /^\/api\/v1\/tickets\/([^/]+)\/dependencies\/([^/]+)$/.exec(path);
  if (rm && call.method === "DELETE") {
    const target = number(decodeURIComponent(rm[1] ?? ""));
    const source = number(decodeURIComponent(rm[2] ?? ""));
    const found = EDGES.find(
      (row) =>
        row.source_id === `TKT-example-${source}` && row.target_id === `TKT-example-${target}`,
    );
    if (!found) return publicError(404, "DEPENDENCY_NOT_FOUND", "There is no such edge.");
    return ok(200, found, "req_fake_rm");
  }
  return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
}

const everyCall: Call[] = [];

afterEach(() => {
  const made = everyCall.splice(0);
  for (const call of made) {
    expect(call.url.pathname).not.toMatch(/\/epics(\/|$)/);
    expect(call.url.pathname).not.toMatch(/\/tickets\/[^/]+\/epic$/);
  }
});

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
      everyCall.push(call);
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
    cycle: ["TKT-example-3", "TKT-example-1", "TKT-example-2", "TKT-example-3"],
  });

function routes(calls: Call[]): string[][] {
  return calls.map((call) => [call.method, `${call.url.pathname}${call.url.search}`]);
}

describe("pidgen epic dag show", () => {
  it("show reads the Epic's dependency graph with GET /tickets/{key}/dependencies/graph", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "epic", "dag", "show", "ALPHA-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: GRAPH,
      error: null,
      meta: { ...META, request_id: "req_fake_dag" },
    });
    expect(routes(calls)).toEqual([["GET", "/api/v1/tickets/ALPHA-12/dependencies/graph"]]);
    expect(calls[0]?.body).toBeUndefined();
    expectAuthenticated(calls[0]);
  });

  it("show percent-encodes the key as one path segment", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "epic", "dag", "show", "EPIC/1");
    expect(code).toBe(ExitCode.NotFound);
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/EPIC%2F1/dependencies/graph");
  });

  it("show: an unknown ticket is the server's TICKET_NOT_FOUND, exits 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "epic", "dag", "show", "ALPHA-99");
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

  it.each([
    ["no key", ["epic", "dag", "show"]],
    ["an empty key", ["epic", "dag", "show", " "]],
    ["a .. key", ["epic", "dag", "show", ".."]],
    ["two keys", ["epic", "dag", "show", "ALPHA-12", "ALPHA-13"]],
    ["an unknown verb", ["epic", "dag", "draw", "ALPHA-12"]],
  ])("usage: dag show with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen epic edge add", () => {
  it("add sends --from as source_id to POST /tickets/{--to}/dependencies and returns the edge", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "epic",
      "edge",
      "add",
      "ALPHA-12",
      "--from",
      "ALPHA-1",
      "--to",
      "ALPHA-3",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: edge(1, 3),
      error: null,
      meta: { ...META, request_id: "req_fake_add" },
    });
    expect(routes(calls)).toEqual([["POST", "/api/v1/tickets/ALPHA-3/dependencies"]]);
    expect(calls[0]?.body).toEqual({ source_id: "ALPHA-1" });
    expectAuthenticated(calls[0]);
  });

  it("add links an Epic to another Epic the same way", async () => {
    const { ctx, calls } = await setup();
    const argv = ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-12", "--to", "ALPHA-13"];
    const { code } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(routes(calls)).toEqual([["POST", "/api/v1/tickets/ALPHA-13/dependencies"]]);
    expect(calls[0]?.body).toEqual({ source_id: "ALPHA-12" });
  });

  it("add --type sends dep_type", async () => {
    const { ctx, calls } = await setup();
    const argv = ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-1", "--to", "ALPHA-3"];
    const { code, body } = await run(ctx, ...argv, "--type", "informs");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(edge(1, 3, "informs"));
    expect(calls[0]?.body).toEqual({ source_id: "ALPHA-1", dep_type: "informs" });
  });

  it("add refused by the server as a cycle (409 DEPENDENCY_CYCLE) keeps the code and exits 5", async () => {
    const { ctx, calls } = await setup({ respond: refusedCycle });
    const argv = ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-3", "--to", "ALPHA-1"];
    const { code, body } = await run(ctx, ...argv);
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
          cycle: ["TKT-example-3", "TKT-example-1", "TKT-example-2", "TKT-example-3"],
        },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("add refused by the server as a self edge (409 DEPENDENCY_SELF_EDGE) exits 5", async () => {
    const { ctx } = await setup();
    const argv = ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-2", "--to", "ALPHA-2"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DEPENDENCY_SELF_EDGE", details: { status: 409 } },
    });
  });

  it("add refused: an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account."),
    });
    const argv = ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-1", "--to", "ALPHA-99"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });

  it.each([
    ["without --from", ["epic", "edge", "add", "ALPHA-12", "--to", "ALPHA-2"]],
    ["without --to", ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-1"]],
    ["with an empty --from", ["epic", "edge", "add", "ALPHA-12", "--from", " ", "--to", "ALPHA-2"]],
    ["with an empty --to", ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-1", "--to", ""]],
    ["with a .. --to", ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-1", "--to", ".."]],
    ["without a key", ["epic", "edge", "add", "--from", "ALPHA-1", "--to", "ALPHA-2"]],
    ["with a .. key", ["epic", "edge", "add", "..", "--from", "ALPHA-1", "--to", "ALPHA-2"]],
    [
      "with two keys",
      ["epic", "edge", "add", "ALPHA-12", "ALPHA-13", "--from", "ALPHA-1", "--to", "ALPHA-2"],
    ],
    [
      "with an unknown --type",
      ["epic", "edge", "add", "ALPHA-12", "--from", "ALPHA-1", "--to", "ALPHA-2", "--type", "x"],
    ],
  ])("usage: edge add %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(code).toBe(2);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen epic edge rm", () => {
  it("rm removes the edge with DELETE /tickets/{--to}/dependencies/{--from} and returns it", async () => {
    const { ctx, calls } = await setup();
    const argv = ["epic", "edge", "rm", "ALPHA-12", "--from", "ALPHA-1", "--to", "ALPHA-2"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: edge(1, 2),
      error: null,
      meta: { ...META, request_id: "req_fake_rm" },
    });
    expect(routes(calls)).toEqual([["DELETE", "/api/v1/tickets/ALPHA-2/dependencies/ALPHA-1"]]);
    expect(calls[0]?.body).toBeUndefined();
    expectAuthenticated(calls[0]);
  });

  it("rm --type sends dep_type as a query parameter", async () => {
    const { ctx, calls } = await setup();
    const argv = ["epic", "edge", "rm", "ALPHA-12", "--from", "ALPHA-2", "--to", "ALPHA-3"];
    const { code } = await run(ctx, ...argv, "--type", "informs");
    expect(code).toBe(ExitCode.Ok);
    expect(routes(calls)).toEqual([
      ["DELETE", "/api/v1/tickets/ALPHA-3/dependencies/ALPHA-2?dep_type=informs"],
    ]);
  });

  it("rm percent-encodes both endpoints as path segments", async () => {
    const { ctx, calls } = await setup();
    const argv = ["epic", "edge", "rm", "ALPHA-12", "--from", "A/1", "--to", "B/2"];
    await run(ctx, ...argv);
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/B%2F2/dependencies/A%2F1");
  });

  it("rm refused: an edge that does not exist exits 4 with DEPENDENCY_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const argv = ["epic", "edge", "rm", "ALPHA-12", "--from", "ALPHA-3", "--to", "ALPHA-1"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DEPENDENCY_NOT_FOUND", details: { status: 404 } },
    });
  });

  it("rm refused by the server (409 DEPENDENCY_TARGET_FROZEN) keeps the code and exits 5", async () => {
    const { ctx } = await setup({
      respond: () =>
        publicError(409, "DEPENDENCY_TARGET_FROZEN", "The target is at or past execution."),
    });
    const argv = ["epic", "edge", "rm", "ALPHA-12", "--from", "ALPHA-1", "--to", "ALPHA-2"];
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DEPENDENCY_TARGET_FROZEN", details: { status: 409 } },
    });
  });

  it.each([
    ["without --from", ["epic", "edge", "rm", "ALPHA-12", "--to", "ALPHA-2"]],
    ["without --to", ["epic", "edge", "rm", "ALPHA-12", "--from", "ALPHA-1"]],
    ["with an empty --to", ["epic", "edge", "rm", "ALPHA-12", "--from", "ALPHA-1", "--to", " "]],
    ["with a .. --from", ["epic", "edge", "rm", "ALPHA-12", "--from", "..", "--to", "ALPHA-2"]],
    ["without a key", ["epic", "edge", "rm", "--from", "ALPHA-1", "--to", "ALPHA-2"]],
    ["with an empty key", ["epic", "edge", "rm", " ", "--from", "ALPHA-1", "--to", "ALPHA-2"]],
  ])("usage: edge rm %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [epic, dag, show, ALPHA-12] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["epic", "dag", "show", "ALPHA-12"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of [
      "Epic dependency graph",
      "Nodes",
      "Pieces",
      "Edges",
      "ALPHA-12",
      "completed",
    ])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);
