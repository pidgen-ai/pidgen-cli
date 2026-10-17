import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
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

/** The Epics: epic-kind Tickets, named by key or id. */
const EPICS: Record<string, { id: string; key: string; project: string }> = {
  "ALPHA-12": { id: "TKT-example-12", key: "ALPHA-12", project: "proj-example-a" },
  "ALPHA-13": { id: "TKT-example-13", key: "ALPHA-13", project: "proj-example-a" },
  "BETA-4": { id: "TKT-example-b4", key: "BETA-4", project: "proj-example-b" },
};
const TASKS = new Set(["ALPHA-8"]);

function ticket(parent: string | null, version: number) {
  return {
    id: "TKT-example-7",
    ticket_key: "ALPHA-7",
    title: "Ticket 7",
    stage: "backlog",
    kind: "task",
    project_id: "proj-example-a",
    parent_ticket_id: parent,
    version,
  };
}

/** ALPHA-7 starts in ALPHA-12 at version 3; PATCH /tickets/ALPHA-7 moves it. */
function server(call: Call): Response {
  const path = call.url.pathname;
  if (path !== "/api/v1/tickets/ALPHA-7") {
    return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
  }
  if (call.method === "GET") return respond(ticket("TKT-example-12", 3), null, "req_fake_read");
  if (call.method !== "PATCH") return publicError(405, "METHOD_NOT_ALLOWED", "No.");
  const { version, parent_ticket_id } = call.body as {
    version: number;
    parent_ticket_id: string | null;
  };
  if (version !== 3) return publicError(409, "CONFLICT", "The ticket changed.");
  if (parent_ticket_id === null) return respond(ticket(null, 4), null, "req_fake_move");
  if (TASKS.has(parent_ticket_id)) {
    return publicError(422, "PARENT_NOT_EPIC", "A task has no children.");
  }
  const epic = EPICS[parent_ticket_id];
  if (!epic) return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
  if (epic.project !== "proj-example-a") {
    return publicError(422, "PARENT_PROJECT_MISMATCH", "The Epic belongs to another Project.");
  }
  const same = epic.id === "TKT-example-12";
  return respond(ticket(epic.id, same ? 3 : 4), null, "req_fake_move");
}

function respond(data: unknown, meta: unknown, requestId: string) {
  return jsonResponse(
    200,
    { status: "ok", data, meta },
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

function routes(calls: Call[]): string[][] {
  return calls.map((call) => [call.method, call.url.pathname]);
}

describe("pidgen ticket move", () => {
  it("move --epic reads the version and sets parent_ticket_id with PATCH /tickets/{ref}", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "ALPHA-13");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: {
        ...ticket("TKT-example-13", 4),
        admission: null,
        move: {
          moved: true,
          previous_parent_ticket_id: "TKT-example-12",
          parent_ticket_id: "TKT-example-13",
        },
      },
      error: null,
      meta: { ...META, request_id: "req_fake_move" },
    });
    expect(routes(calls)).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-7"],
      ["PATCH", "/api/v1/tickets/ALPHA-7"],
    ]);
    expect(calls[1]?.body).toEqual({ version: 3, parent_ticket_id: "ALPHA-13" });
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        "x-pidgen-account": "ACC-EXAMPLE",
      });
    }
  });

  it("move --no-epic clears parent_ticket_id by sending null", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--no-epic");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({
      ...ticket(null, 4),
      admission: null,
      move: { moved: true, previous_parent_ticket_id: "TKT-example-12", parent_ticket_id: null },
    });
    expect(routes(calls)).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-7"],
      ["PATCH", "/api/v1/tickets/ALPHA-7"],
    ]);
    expect(calls[1]?.body).toEqual({ version: 3, parent_ticket_id: null });
  });

  it("move never calls POST /tickets/{ref}/epic nor sends epic_id", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "ALPHA-13");
    await run(ctx, "ticket", "move", "ALPHA-7", "--no-epic");
    for (const call of calls) {
      expect(call.url.pathname).not.toMatch(/\/epics?(\/|$)/);
      expect(call.body ?? {}).not.toHaveProperty("epic_id");
    }
  });

  it("move into the Epic the ticket is already in reports moved: false", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "ALPHA-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data?.["move"]).toEqual({
      moved: false,
      previous_parent_ticket_id: "TKT-example-12",
      parent_ticket_id: "TKT-example-12",
    });
  });

  it("move reports the server's edit meta as admission", async () => {
    const meta = { admission_invalidated: true, planning_restarted: false };
    const { ctx } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? respond(ticket("TKT-example-12", 3), null, "req_fake_read")
          : respond(ticket(null, 4), meta, "req_fake_move"),
    });
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--no-epic");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data?.["admission"]).toEqual(meta);
  });

  it("move percent-encodes the ref as one path segment", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "ticket", "move", "TKT/7", "--no-epic");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/TKT%2F7");
  });

  it("move refused: an Epic of another project exits 2 with PARENT_PROJECT_MISMATCH", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "BETA-4");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "PARENT_PROJECT_MISMATCH",
        message: "The Epic belongs to another Project.",
        details: { status: 422, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(2);
  });

  it("move refused: a parent that is not an Epic exits 2 with PARENT_NOT_EPIC", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "ALPHA-8");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "PARENT_NOT_EPIC" } });
  });

  it("move refused: an unknown Epic exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "ALPHA-99");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });

  it("move refused: an unknown ticket exits 4 with TICKET_NOT_FOUND and sends no PATCH", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-99", "--no-epic");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
    expect(routes(calls)).toEqual([["GET", "/api/v1/tickets/ALPHA-99"]]);
  });

  it("move refused by the server as forbidden (403 FORBIDDEN) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not update this Ticket."),
    });
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--epic", "ALPHA-13");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "FORBIDDEN", details: { status: 403 } },
    });
  });

  it("move refused by the server as a conflict (409 CONFLICT) exits 5 with its code", async () => {
    const { ctx } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? respond(ticket("TKT-example-12", 3), null, "req_fake_read")
          : publicError(409, "CONFLICT", "The ticket changed."),
    });
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--no-epic");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CONFLICT" } });
  });

  it("move: a ticket the server reports without a version exits 1 and sends no PATCH", async () => {
    const { ctx, calls } = await setup({
      respond: () => respond({ ...ticket(null, 0), version: null }, null, "req_fake_read"),
    });
    const { code, body } = await run(ctx, "ticket", "move", "ALPHA-7", "--no-epic");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, error: { code: "UNEXPECTED_RESPONSE" } });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["both --epic and --no-epic", ["ticket", "move", "ALPHA-7", "--epic", "ALPHA-13", "--no-epic"]],
    ["both --no-epic and --epic", ["ticket", "move", "ALPHA-7", "--no-epic", "--epic", "ALPHA-13"]],
    ["neither --epic nor --no-epic", ["ticket", "move", "ALPHA-7"]],
    ["an empty --epic", ["ticket", "move", "ALPHA-7", "--epic", " "]],
    ["--epic without a key", ["ticket", "move", "ALPHA-7", "--epic"]],
    ["no ref", ["ticket", "move", "--epic", "ALPHA-13"]],
    ["a .. ref", ["ticket", "move", "..", "--no-epic"]],
    ["two refs", ["ticket", "move", "ALPHA-7", "ALPHA-8", "--no-epic"]],
  ])("usage: move with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(code).toBe(2);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});
