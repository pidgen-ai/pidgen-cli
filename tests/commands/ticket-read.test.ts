import { describe, expect, it } from "vitest";
import bundled from "../../contracts/openapi.json" with { type: "json" };
import { runCli } from "../../src/cli.js";
import { INTERVENTION_TYPES, TICKET_STAGES } from "../../src/commands/ticket/list.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { MAX_PAGES, PAGE_SIZE } from "../../src/core/read.js";
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

function ticket(n: number): Record<string, unknown> {
  return {
    id: `TKT-example-${n}`,
    ticket_key: `ALPHA-${n}`,
    account_id: "ACC-EXAMPLE",
    project_id: "proj-example-a",
    stage: "backlog",
    title: `Ticket ${n}`,
    epic_id: null,
    parent_ticket_id: null,
  };
}

function tickets(from: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ticket(from + i));
}

const DETAIL = {
  ...ticket(12),
  delivery: { state: "none" },
  effective_merge_policy: { mode: "manual" },
  open_findings: [],
};

const PREREQUISITES = {
  ticket_id: "TKT-example-12",
  ticket_key: "ALPHA-12",
  stage: "backlog",
  high_level_root_id: "TKT-example-12",
  high_level_root_key: "ALPHA-12",
  ready: false,
  readiness_blockers: ["blocking_prerequisites"],
  blockers: [{ code: "blocking_prerequisites", message: "A prerequisite is unfinished." }],
  blocking_prerequisites: [
    { id: "TKT-example-3", ticket_key: "ALPHA-3", title: "Ticket 3", stage: "in_execution" },
  ],
};

function publicError(status: number, code: string, message: string) {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details: null, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

function page(data: unknown[], number: number, requestId = `req_fake_page_${number}`) {
  return jsonResponse(
    200,
    { status: "ok", data, meta: { page: number, per_page: PAGE_SIZE } },
    { "x-request-id": requestId, "pidgen-api-version": "1.0" },
  );
}

/** Answers `GET /tickets` from `pages` by the requested page number, and the ticket routes. */
function server(pages: unknown[][] = [tickets(1, 2)]) {
  return (call: Call): Response => {
    const path = call.url.pathname;
    if (path === "/api/v1/tickets") {
      const number = Number(call.url.searchParams.get("page") ?? "1");
      return page(pages[number - 1] ?? [], number);
    }
    if (path === "/api/v1/tickets/ALPHA-12") {
      return jsonResponse(
        200,
        { status: "ok", data: DETAIL, meta: null },
        { "x-request-id": "req_fake_ticket", "pidgen-api-version": "1.0" },
      );
    }
    if (path === "/api/v1/tickets/ALPHA-12/prerequisites") {
      return jsonResponse(
        200,
        { status: "ok", data: PREREQUISITES, meta: null },
        { "x-request-id": "req_fake_prerequisites" },
      );
    }
    return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
  };
}

async function setup(options: { respond?: (call: Call) => Response; config?: Config | null } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? server();
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

function query(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(call?.url.searchParams ?? []);
}

describe("pidgen ticket list", () => {
  it("list returns the Account's tickets in data, with the server's meta", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: tickets(1, 2),
      error: null,
      meta: {
        request_id: "req_fake_page_1",
        api_version: "1.0",
        profile: "default",
        account: "ACC-EXAMPLE",
        cli_version: "0.0.0-test",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets");
    expect(query(calls[0])).toEqual({ page: "1", per_page: String(PAGE_SIZE) });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("filters: every filter is sent as the route's query parameter", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "list",
      "--stage",
      "in_execution",
      "--project",
      "proj-example-a",
      "--query",
      "  login page  ",
      "--intervention",
      "clarification_needed",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: tickets(1, 2), error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets");
    expect(query(calls[0])).toEqual({
      stage: "in_execution",
      project_id: "proj-example-a",
      q: "login page",
      intervention: "clarification_needed",
      page: "1",
      per_page: String(PAGE_SIZE),
    });
  });

  it("filters: an omitted filter is not sent", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "ticket", "list", "--stage", "failed");
    expect(code).toBe(ExitCode.Ok);
    expect(query(calls[0])).toEqual({ stage: "failed", page: "1", per_page: String(PAGE_SIZE) });
  });

  it("filters: --stage and --intervention accept every value the public document lists", () => {
    const schemas = bundled.components.schemas;
    expect([...TICKET_STAGES]).toEqual(schemas.TicketStage.enum);
    expect([...INTERVENTION_TYPES]).toEqual(schemas.InterventionType.enum);
  });

  it("pages: list follows pages until the last and keeps every filter on each page", async () => {
    const pages = [tickets(1, PAGE_SIZE), tickets(101, PAGE_SIZE), tickets(201, 3)];
    const { ctx, calls } = await setup({ respond: server(pages) });
    const { code, body } = await run(ctx, "ticket", "list", "--stage", "backlog");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(pages.flat());
    expect((body.data as unknown[]).length).toBe(2 * PAGE_SIZE + 3);
    expect(body.meta).toMatchObject({ request_id: "req_fake_page_1" });
    expect(calls.map((call) => query(call))).toEqual(
      [1, 2, 3].map((n) => ({ stage: "backlog", page: String(n), per_page: String(PAGE_SIZE) })),
    );
  });

  it("pages: a full last page is followed by one empty page, then list stops", async () => {
    const pages = [tickets(1, PAGE_SIZE)];
    const { ctx, calls } = await setup({ respond: server(pages) });
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(pages[0]);
    expect(calls.map((call) => query(call)["page"])).toEqual(["1", "2"]);
  });

  it("pages: an Account with no tickets gives an empty array after one page", async () => {
    const { ctx, calls } = await setup({ respond: server([]) });
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: [], error: null });
    expect(calls).toHaveLength(1);
  });

  it("pages: a refusal on a later page fails the whole list", async () => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.url.searchParams.get("page") === "1"
          ? page(tickets(1, PAGE_SIZE), 1)
          : publicError(403, "FORBIDDEN", "The token may not read tickets."),
    });
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
    expect(calls).toHaveLength(2);
  });

  it("pages: a server that never returns a short page stops after the page limit", async () => {
    const { ctx, calls } = await setup({ respond: () => page(tickets(1, PAGE_SIZE), 1) });
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "UNEXPECTED_RESPONSE", details: { pages: MAX_PAGES } },
    });
    expect(calls).toHaveLength(MAX_PAGES);
  });

  it("list refused by the server (403 FORBIDDEN) keeps the code and exits 3", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not read tickets."),
    });
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "FORBIDDEN",
        message: "The token may not read tickets.",
        details: { status: 403, request_id: "req_fake_error" },
      },
    });
  });

  it("list refused as invalid by the server (422 INPUT_INVALID) exits 2", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "INPUT_INVALID", "The request failed validation."),
    });
    const { code, body } = await run(ctx, "ticket", "list", "--project", "proj-example-a");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
  });

  it("list with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: an invalid --stage value exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", "--stage", "shipped");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(/shipped/);
    expect(calls).toHaveLength(0);
  });

  it("usage: an invalid --intervention value exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", "--intervention", "stuck");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["--project", ""],
    ["--project", "  "],
    ["--query", ""],
    ["--query", " "],
  ])("usage: %s %j exits 2 and sends nothing", async (flag, value) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", flag, value);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", details: { option: flag } },
    });
    expect(calls).toHaveLength(0);
  });

  it("usage: a --query longer than 200 characters exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", "--query", "x".repeat(201));
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", details: { option: "--query", max_length: 200 } },
    });
    expect(calls).toHaveLength(0);
  });

  it("usage: --epic is not available yet and exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", "--epic", "ALPHA-E1");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: list with an argument exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", "ALPHA-1");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket show", () => {
  it("show returns the ticket with its prerequisites, and the ticket's meta", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { ...DETAIL, prerequisites: PREREQUISITES },
      error: null,
      meta: {
        request_id: "req_fake_ticket",
        api_version: "1.0",
        profile: "default",
        account: "ACC-EXAMPLE",
        cli_version: "0.0.0-test",
      },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-12"],
      ["GET", "/api/v1/tickets/ALPHA-12/prerequisites"],
    ]);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        "x-pidgen-account": "ACC-EXAMPLE",
      });
    }
  });

  it("show prints the ticket's outcome pause and cancellation as the server sends them", async () => {
    const outcomePause = {
      state: "pausing",
      requested_by: { user_id: "usr-example", display_name: "Example User" },
      requested_at: "2026-09-28T10:00:00Z",
    };
    const cancellation = {
      cancellation_id: "cnc-example",
      disposition: "superseded",
      superseded_by: { ticket_id: "TKT-example-13", ticket_key: "ALPHA-13" },
      reason: "Replaced",
      requested_by: { user_id: "usr-example", display_name: "Example User" },
      requested_at: "2026-09-28T10:00:00Z",
      state: "halting",
      pull_request_close: "pending",
      awaiting: ["execution_stop", "pull_request_close"],
    };
    const base = server();
    const { ctx } = await setup({
      respond: (call) =>
        call.url.pathname === "/api/v1/tickets/ALPHA-12"
          ? jsonResponse(
              200,
              {
                status: "ok",
                data: { ...DETAIL, outcome_pause: outcomePause, cancellation },
                meta: null,
              },
              { "x-request-id": "req_fake_ticket" },
            )
          : base(call),
    });
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      outcome_pause: outcomePause,
      cancellation,
      prerequisites: { ready: false },
    });
  });

  it("show prints a ticket with no pause and no cancellation as null for both", async () => {
    const base = server();
    const { ctx } = await setup({
      respond: (call) =>
        call.url.pathname === "/api/v1/tickets/ALPHA-12"
          ? jsonResponse(
              200,
              {
                status: "ok",
                data: { ...DETAIL, outcome_pause: null, cancellation: null },
                meta: null,
              },
              { "x-request-id": "req_fake_ticket" },
            )
          : base(call),
    });
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toHaveProperty("outcome_pause", null);
    expect(body.data).toHaveProperty("cancellation", null);
  });

  it("prerequisites: show includes each blocking prerequisite by key and stage", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-12");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      ticket_key: "ALPHA-12",
      prerequisites: {
        ready: false,
        readiness_blockers: ["blocking_prerequisites"],
        blocking_prerequisites: [{ ticket_key: "ALPHA-3", stage: "in_execution" }],
      },
    });
  });

  it("prerequisites: a refusal of the prerequisites fails show", async () => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.url.pathname.endsWith("/prerequisites")
          ? publicError(403, "FORBIDDEN", "The token may not read prerequisites.")
          : server()(call),
    });
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-12");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
    expect(calls).toHaveLength(2);
  });

  it("show sends the ref as one encoded path segment", async () => {
    const { ctx, calls } = await setup({
      respond: () => jsonResponse(200, { status: "ok", data: {} }),
    });
    const { code } = await run(ctx, "ticket", "show", "a/b c");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => call.url.toString())).toEqual([
      `${SERVER}/api/v1/tickets/a%2Fb%20c`,
      `${SERVER}/api/v1/tickets/a%2Fb%20c/prerequisites`,
    ]);
  });

  it("not found: an unknown ticket exits 4 with TICKET_NOT_FOUND and skips the prerequisites", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-999");
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
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-999");
  });

  it("not found: a 404 without a code exits 4 with NOT_FOUND", async () => {
    const { ctx } = await setup({ respond: () => jsonResponse(404, { detail: "Not Found" }) });
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-999");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("usage: show without a ref exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "show");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(/ref/);
    expect(calls).toHaveLength(0);
  });

  it.each(["", " ", ".", ".."])(
    "usage: show with the ref %j exits 2 and sends nothing",
    async (ref) => {
      const { ctx, calls } = await setup();
      const { code, body } = await run(ctx, "ticket", "show", ref);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: { code: "CLI_USAGE", details: { argument: "ticket ref" } },
      });
      expect(calls).toHaveLength(0);
    },
  );

  it("usage: show with two refs exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "show", "ALPHA-1", "ALPHA-2");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: ticket list at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["ticket", "list"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Tickets (2 displayed)", "ALPHA-1", "backlog"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: ticket show at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["ticket", "show", "ALPHA-12"];
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
    "Ticket",
    "Prerequisites",
    "Blocking prerequisites",
    "ALPHA-3",
    "in_execution",
    "Open findings (0 displayed)",
  ])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});
