import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { commands } from "../../src/commands/index.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

// `pidgen ticket history` against a fake of the published History contract (`GET
// /tickets/{ticket_id}/history`): no test calls a real server.

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

const PERSON = { kind: "user", id: "usr-example-1", display_name: "Example Person" };

/** The ticket's whole history, oldest first; `sequence` is the position in it. */
const WHOLE_HISTORY = [
  entry(1, "stage_change", "observations", "Moved to Backlog", { actor: null }),
  entry(2, "edit", "people", "Edited the title", { actor: PERSON, reason: "Clearer wording" }),
  entry(3, "command", "observations", "Refinement started", { status: "accepted" }),
  entry(4, "review_decision", "people", "Requested changes", { actor: PERSON, code: "CHANGES" }),
  entry(5, "stage_change", "observations", "Moved to Implementation Ready", { actor: null }),
];

function entry(
  sequence: number,
  kind: string,
  category: "people" | "observations",
  summary: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sequence,
    occurred_at: `2026-10-05T09:0${sequence}:00Z`,
    kind,
    category,
    actor: null,
    summary,
    reason: null,
    status: null,
    code: null,
    ...overrides,
  };
}

function ok(data: unknown, requestId = "req_fake_history") {
  return jsonResponse(
    200,
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

/**
 * Answers `GET /tickets/ALPHA-7/history` as the contract states it: `show` keeps one category
 * (the sequence stays the entry's place in the whole history), `after` skips entries up to that
 * sequence, `limit` (default 100) caps a page, and `next_after` is the last sequence returned when
 * more remain, else null.
 */
function server(call: Call): Response {
  if (call.url.pathname !== "/api/v1/tickets/ALPHA-7/history" || call.method !== "GET") {
    return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
  }
  const show = call.url.searchParams.get("show") ?? "everything";
  const after = Number(call.url.searchParams.get("after") ?? 0);
  const limit = Number(call.url.searchParams.get("limit") ?? 100);
  const matching = WHOLE_HISTORY.filter(
    (item) => item.sequence > after && (show === "everything" || item.category === show),
  );
  const entries = matching.slice(0, limit);
  const more = matching.length > entries.length;
  return ok({
    ticket_id: "TKT-example-7",
    entries,
    next_after: more ? (entries[entries.length - 1]?.sequence ?? null) : null,
  });
}

async function setup(options: { respond?: (call: Call) => Response; config?: Config | null } = {}) {
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
  if (options.config !== null) await saveConfig(ctx, options.config ?? CONFIG);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

const META = {
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

/** The query a call sent, as `{name: value}`. */
function queryOf(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(call?.url.searchParams.entries() ?? []);
}

describe("pidgen ticket history", () => {
  it("is registered as ticket history", () => {
    expect(commands.some((spec) => spec.path.join(" ") === "ticket history")).toBe(true);
  });

  it("history reads GET /tickets/{ref}/history and prints the server's entries in one envelope", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { ticket_id: "TKT-example-7", entries: WHOLE_HISTORY, next_after: null },
      error: null,
      meta: { ...META, request_id: "req_fake_history" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-7/history");
    // Nothing the caller did not ask for is sent: the server's defaults apply.
    expect(queryOf(calls[0])).toEqual({});
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("history of a ticket with no entries prints an empty list", async () => {
    const { ctx } = await setup({
      respond: () => ok({ ticket_id: "TKT-example-7", entries: [], next_after: null }),
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ ticket_id: "TKT-example-7", entries: [], next_after: null });
  });

  it.each(["everything", "people", "observations"])(
    "history --show %s is sent as the show filter",
    async (show) => {
      const { ctx, calls } = await setup();
      const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", "--show", show);
      expect(code).toBe(ExitCode.Ok);
      expect(queryOf(calls[0])).toEqual({ show });
      const entries = (body.data as { entries: { category: string }[] }).entries;
      const expected = WHOLE_HISTORY.filter(
        (item) => show === "everything" || item.category === show,
      );
      expect(entries).toEqual(expected);
    },
  );

  it("history keeps each entry's sequence under a filter", async () => {
    const { ctx } = await setup();
    const { body } = await run(ctx, "ticket", "history", "ALPHA-7", "--show", "people");
    const entries = (body.data as { entries: { sequence: number }[] }).entries;
    expect(entries.map((item) => item.sequence)).toEqual([2, 4]);
  });

  it("history --after and --limit are sent, and a page with more prints next_after", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "history",
      "ALPHA-7",
      "--after",
      "1",
      "--limit",
      "2",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(queryOf(calls[0])).toEqual({ after: "1", limit: "2" });
    expect(calls).toHaveLength(1);
    expect(body.data).toEqual({
      ticket_id: "TKT-example-7",
      entries: WHOLE_HISTORY.slice(1, 3),
      next_after: 3,
    });
  });

  it("history without --all reads one page and leaves next_after for the caller", async () => {
    const { ctx, calls } = await setup();
    const { body } = await run(ctx, "ticket", "history", "ALPHA-7", "--limit", "2");
    expect(calls).toHaveLength(1);
    expect((body.data as { next_after: number | null }).next_after).toBe(2);
  });

  it("history --after 0 and the largest --limit are accepted", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(
      ctx,
      "ticket",
      "history",
      "ALPHA-7",
      "--after",
      "0",
      "--limit",
      "200",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(queryOf(calls[0])).toEqual({ after: "0", limit: "200" });
  });

  it("history --all follows next_after until it is null and prints every entry in order", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", "--all", "--limit", "2");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(queryOf)).toEqual([
      { limit: "2" },
      { limit: "2", after: "2" },
      { limit: "2", after: "4" },
    ]);
    expect(body).toEqual({
      ok: true,
      data: { ticket_id: "TKT-example-7", entries: WHOLE_HISTORY, next_after: null },
      error: null,
      meta: { ...META, request_id: "req_fake_history" },
    });
  });

  it("history --all of a history that fits one page makes one request", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", "--all");
    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(queryOf(calls[0])).toEqual({});
    expect(body.data).toEqual({
      ticket_id: "TKT-example-7",
      entries: WHOLE_HISTORY,
      next_after: null,
    });
  });

  it("history --all starts after --after and keeps --show on every page", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "history",
      "ALPHA-7",
      "--all",
      "--show",
      "observations",
      "--after",
      "1",
      "--limit",
      "1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => call.url.searchParams.get("after"))).toEqual(["1", "3"]);
    for (const call of calls) {
      expect(call.url.searchParams.get("show")).toBe("observations");
      expect(call.url.searchParams.get("limit")).toBe("1");
    }
    const entries = (body.data as { entries: { sequence: number }[] }).entries;
    expect(entries.map((item) => item.sequence)).toEqual([3, 5]);
    expect((body.data as { next_after: number | null }).next_after).toBeNull();
  });

  it("history --all reports the first page's request id in meta", async () => {
    const { ctx } = await setup({
      respond: (call) => {
        const first = !call.url.searchParams.has("after");
        return ok(
          {
            ticket_id: "TKT-example-7",
            entries: first ? WHOLE_HISTORY.slice(0, 2) : WHOLE_HISTORY.slice(2),
            next_after: first ? 2 : null,
          },
          first ? "req_fake_first" : "req_fake_last",
        );
      },
    });
    const { body } = await run(ctx, "ticket", "history", "ALPHA-7", "--all");
    expect(body.meta).toMatchObject({ request_id: "req_fake_first" });
    expect((body.data as { entries: unknown[] }).entries).toEqual(WHOLE_HISTORY);
  });

  it("history --all refuses a cursor that does not advance instead of looping", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        ok({ ticket_id: "TKT-example-7", entries: WHOLE_HISTORY.slice(0, 2), next_after: 2 }),
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", "--all");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNEXPECTED_RESPONSE" } });
    // The first page names cursor 2; the second, asked after 2, names 2 again.
    expect(calls).toHaveLength(2);
  });

  it("history --all stops after the page limit when the server keeps advancing", async () => {
    const { ctx, calls } = await setup({
      respond: (call) => {
        const after = Number(call.url.searchParams.get("after") ?? 0);
        return ok({
          ticket_id: "TKT-example-7",
          entries: [entry(after + 1, "edit", "people", "Edited")],
          next_after: after + 1,
        });
      },
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", "--all", "--limit", "1");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "UNEXPECTED_RESPONSE", details: { max_pages: 1000, limit: 1 } },
    });
    expect(calls).toHaveLength(1000);
  });

  it("history --all fails whole when a later page is refused, rather than printing part of the history", async () => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.url.searchParams.has("after")
          ? publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.")
          : server(call),
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", "--all", "--limit", "2");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
    expect(calls).toHaveLength(2);
  });

  it("history percent-encodes the ticket reference as one path segment", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "ticket", "history", "ALPHA/../7");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA%2F..%2F7/history");
  });

  it("history of an unknown ticket (404 TICKET_NOT_FOUND) exits 4", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-404");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "TICKET_NOT_FOUND",
        message: "No such Ticket in the Account.",
        details: { status: 404 },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("history against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup({
      respond: () => jsonResponse(404, { detail: "Not Found" }, { "x-request-id": "req_fake_404" }),
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "NOT_FOUND", details: { status: 404 } },
    });
  });

  it("history refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not read this Ticket."),
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it("history rejected by the server as invalid input (422) exits 2 with its code", async () => {
    const { ctx } = await setup({
      respond: () =>
        publicError(422, "INPUT_INVALID", "The request failed validation.", {
          errors: [{ loc: ["query", "show"], msg: "Input should be a valid enumeration member" }],
        }),
    });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
  });

  it("history with no credential exits 3 and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an unknown --show", ["--show", "everyone"], /everyone|--show/],
    ["a --show with no value", ["--show"], /argument missing|--show/],
    ["a --limit of 0", ["--limit", "0"], /--limit/],
    ["a --limit above 200", ["--limit", "201"], /--limit/],
    ["a --limit that is not a number", ["--limit", "many"], /--limit/],
    ["a --limit that is not a whole number", ["--limit", "1.5"], /--limit/],
    ["a negative --limit", ["--limit", "-5"], /--limit/],
    ["a --limit with no value", ["--limit"], /argument missing|--limit/],
    ["an --after that is not a number", ["--after", "later"], /--after/],
    ["an --after that is not a whole number", ["--after", "2.5"], /--after/],
    ["a negative --after", ["--after", "-1"], /--after/],
    ["an --after with no value", ["--after"], /argument missing|--after/],
    ["an unknown flag", ["--since", "1"], /unknown option/],
  ])("usage: history with %s exits 2 and sends nothing", async (_, flags, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "history", "ALPHA-7", ...flags);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("usage: an unknown --show names the values it accepts", async () => {
    const { ctx } = await setup();
    const { body } = await run(ctx, "ticket", "history", "ALPHA-7", "--show", "everyone");
    for (const value of ["everything", "people", "observations"]) {
      expect(body.error?.message).toContain(value);
    }
  });

  it.each([
    ["no ref", ["ticket", "history"], /missing required argument/],
    ["a blank ref", ["ticket", "history", "  "], /ticket ref is required/],
    ["a .. ref", ["ticket", "history", ".."], /Not a valid ticket ref/],
    ["two refs", ["ticket", "history", "ALPHA-7", "ALPHA-8"], /too many arguments/],
  ])("usage: history with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(message);
    expect(calls).toHaveLength(0);
  });
});

describe("ticket history documentation", () => {
  it("docs/commands.md lists the command, its flags and the server it needs", async () => {
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    const row = text.split("\n").find((line) => line.startsWith("| `pidgen ticket history"));
    expect(row).toBeDefined();
    expect(row?.replaceAll("\\|", "|")).toContain("--show everything|people|observations");
    expect(row).toContain("--after");
    expect(row).toContain("--limit");
    expect(row).toContain("--all");
    expect(row).toContain("GET /tickets/{ref}/history");
    expect(row).toContain("GET /tickets/{ref}/history");
    const section = text.slice(text.indexOf("### ticket history"), text.indexOf("## intent"));
    expect(section).toContain("next_after");
    expect(section).toContain("sequence");
    expect(section).toContain("--all");
    expect(section).toMatch(/404/);
    expect(section).toMatch(/exit code 4/);
    expect(section).toMatch(/exit code 2/);
    expect(text).toContain("`pidgen ticket history`");
  });

  it("docs/commands.md documents title edits, the new refusals and planning_restarted", async () => {
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    const edit = text.slice(
      text.indexOf("- `pidgen ticket edit <ref> -f <file>`"),
      text.indexOf("- `pidgen ticket owner"),
    );
    expect(edit).toContain("`title`");
    expect(edit).toContain("EDIT_STAGE_NOT_ALLOWED");
    expect(edit).toContain("EDIT_MERGE_POLICY_LOCKED");
    expect(edit).toContain("details.field");
    expect(edit).toContain("details.stage");
    expect(edit).toContain("planning_restarted");
    expect(edit).toContain("admission");
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: history at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["ticket", "history", "ALPHA-7"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Ticket history", "Entries (5 displayed)", "Moved to Backlog", "Next after"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});
