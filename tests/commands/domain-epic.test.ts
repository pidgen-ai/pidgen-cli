import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import {
  DOMAIN_EPIC_BOARD,
  DOMAIN_EPIC_CREATED,
  DOMAIN_IDS,
  publicError,
  publishedIssues,
} from "../support/published.js";

// Filing a Domain Epic (pidgen ticket create --domain, pidgen epic create --domain) and reading a
// domain's Epics (pidgen domain epics) with a fake fetch answering fixtures shaped by the published
// document (tests/support/published.ts): routes, bodies, data, refusals and usage errors.

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
  request_id: "req_fake_ok",
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

/** A refusal in the public error shape, as the published route's response states it. */
function errorExample(code: string, details: Record<string, unknown> | null = null) {
  return publicError(code, `The server refuses: ${code}.`, details);
}

const CREATED = DOMAIN_EPIC_CREATED as unknown as Record<string, unknown>;
const BOARD = DOMAIN_EPIC_BOARD as unknown as {
  epics: Array<{
    epic: Record<string, unknown>;
    domain_id: string;
    projects: Array<{ project: { key: string }; ticket_ids: string[] }>;
    hidden: number;
  }>;
  tickets: Array<Record<string, unknown>>;
  running: number | null;
};

const DOMAIN_EPIC = {
  title: "Checkout across payments and cards",
  description: "One checkout across the payment and card projects.",
  target_date: "2026-12-01T00:00:00Z",
};

function ok(status: number, data: unknown, meta: unknown = null) {
  return jsonResponse(
    status,
    { status: "ok", data, meta },
    { "x-request-id": "req_fake_ok", "pidgen-api-version": "1.0" },
  );
}

function refusal(status: number, body: unknown) {
  return jsonResponse(status, body, { "x-request-id": "req_fake_error" });
}

async function setup(options: { respond?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? (() => ok(201, CREATED));
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

async function file(ctx: TestContext, name: string, content: unknown): Promise<string> {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(join(ctx.cwd, name), text);
  return name;
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

function route(call: Call | undefined): [string, string] {
  return [call?.method ?? "", `${call?.url.pathname ?? ""}${call?.url.search ?? ""}`];
}

describe("pidgen ticket create --domain / pidgen epic create --domain", () => {
  it.each([
    ["ticket create --domain", ["ticket", "create", "--domain", "PAY", "-f"]],
    [
      "ticket create --kind epic --domain",
      ["ticket", "create", "--kind", "epic", "--domain", "PAY", "-f"],
    ],
    ["epic create --domain", ["epic", "create", "--domain", "PAY", "-f"]],
  ])("%s sends POST /tickets with kind epic and domain_id, and no project_id", async (_, argv) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", DOMAIN_EPIC);
    const { code, body } = await run(ctx, ...argv, name);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: CREATED, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(route(calls[0])).toEqual(["POST", "/api/v1/tickets"]);
    expect(calls[0]?.body).toEqual({ ...DOMAIN_EPIC, kind: "epic", domain_id: "PAY" });
    expect(calls[0]?.body).not.toHaveProperty("project_id");
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("accepts a file that already says kind: epic, and the domain's id", async () => {
    const { ctx, calls } = await setup();
    const name = await file(
      ctx,
      "epic.yaml",
      "title: Checkout\nkind: epic\nparent_ticket_id: EXMPL-3\n",
    );
    const { code } = await run(
      ctx,
      "ticket",
      "create",
      "--domain",
      " dom-example-pay ",
      "-f",
      name,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      title: "Checkout",
      kind: "epic",
      parent_ticket_id: "EXMPL-3",
      domain_id: "dom-example-pay",
    });
  });

  it("validates the body against the published create request, which carries domain_id", async () => {
    // A field the published CreateTicketRequest does not know is refused before any request.
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", { ...DOMAIN_EPIC, priority_weight: 3 });
    const { code, body } = await run(ctx, "epic", "create", "--domain", "PAY", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID", details: { method: "POST", path: "/tickets" } },
    });
    expect(JSON.stringify(body.error?.details["issues"])).toContain("priority_weight");
    expect(calls).toHaveLength(0);

    const bad = await file(ctx, "bad.json", { ...DOMAIN_EPIC, target_date: 12 });
    const second = await run(ctx, "ticket", "create", "--domain", "PAY", "-f", bad);
    expect(second.code).toBe(ExitCode.Usage);
    expect(second.body.error?.details["issues"]).toEqual([
      expect.objectContaining({ path: "$.target_date" }),
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket create --domain usage", () => {
  it.each(["story", "task"])(
    "--domain with --kind %s is INPUT_INVALID (exit 2) and sends nothing",
    async (kind) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "epic.json", DOMAIN_EPIC);
      const { code, body } = await run(
        ctx,
        "ticket",
        "create",
        "--kind",
        kind,
        "--domain",
        "PAY",
        "-f",
        name,
      );
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: { code: "INPUT_INVALID", details: { option: "--kind", value: kind } },
      });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ["project_id", { project_id: "ALPHA" }],
    ["branch_mode", { branch_mode: "create_new" }],
    ["feature_branch", { feature_branch: "epic/checkout" }],
    ["project_id even null", { project_id: null }],
    ["kind story", { kind: "story" }],
    ["another domain_id", { domain_id: "CARDS" }],
  ])(
    "a file naming %s with --domain is INPUT_INVALID (exit 2) and sends nothing",
    async (_, extra) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "epic.json", { ...DOMAIN_EPIC, ...extra });
      for (const argv of [
        ["ticket", "create", "--domain", "PAY", "-f", name],
        ["epic", "create", "--domain", "PAY", "-f", name],
      ]) {
        const { code, body } = await run(ctx, ...argv);
        expect(code).toBe(ExitCode.Usage);
        expect(body).toMatchObject({
          ok: false,
          data: null,
          error: {
            code: "INPUT_INVALID",
            details: {
              method: "POST",
              path: "/tickets",
              issues: [{ path: `$.${Object.keys(extra)[0]!}` }],
            },
          },
        });
      }
      expect(calls).toHaveLength(0);
    },
  );

  it("names every refused field at once", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", {
      ...DOMAIN_EPIC,
      project_id: "ALPHA",
      branch_mode: "target",
      feature_branch: "main",
    });
    const { code, body } = await run(ctx, "ticket", "create", "--domain", "PAY", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    const issues = body.error?.details["issues"] as Array<{ path: string }>;
    expect(issues.map((issue) => issue.path)).toEqual([
      "$.project_id",
      "$.branch_mode",
      "$.feature_branch",
    ]);
    expect(calls).toHaveLength(0);
  });

  it("an empty --domain is a usage error (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", DOMAIN_EPIC);
    const { code, body } = await run(ctx, "ticket", "create", "--domain", " ", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE", details: { option: "--domain" } });
    expect(calls).toHaveLength(0);
  });

  it("without --domain a file naming domain_id is sent as written, since the published request carries it", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", { ...DOMAIN_EPIC, domain_id: "PAY" });
    const { code, body } = await run(ctx, "ticket", "create", "--kind", "epic", "-f", name);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ ...DOMAIN_EPIC, kind: "epic", domain_id: "PAY" });
  });
});

describe("pidgen ticket create --domain refusals", () => {
  // The details the published create states for a refusal.
  const DETAILS: Record<string, Record<string, unknown>> = {
    DOMAIN_HAS_NO_PROJECTS: { domain_id: DOMAIN_IDS.cards },
    EPIC_FIELD_REFUSED: { field: "branch_mode" },
    ENTITLEMENT_LIMIT_REACHED: { entitlement: "domains" },
  };

  it.each([
    ["DOMAIN_HAS_NO_PROJECTS", "422", ExitCode.Refused],
    ["DOMAIN_PROJECT_CONFLICT", "422", ExitCode.Usage],
    ["EPIC_FIELD_REFUSED", "422", ExitCode.Usage],
    ["DOMAIN_NOT_FOUND", "404", ExitCode.NotFound],
    ["FORBIDDEN", "403", ExitCode.Auth],
    ["ENTITLEMENT_LIMIT_REACHED", "403", ExitCode.Auth],
  ] as const)(
    "%s (%s) exits %i with the server's code and message",
    async (refused, status, exitCode) => {
      const answer = errorExample(refused, DETAILS[refused] ?? null);
      const { ctx, calls } = await setup({ respond: () => refusal(Number(status), answer) });
      const name = await file(ctx, "epic.json", DOMAIN_EPIC);
      for (const argv of [
        ["ticket", "create", "--domain", "PAY", "-f", name],
        ["epic", "create", "--domain", "PAY", "-f", name],
      ]) {
        const { code, body } = await run(ctx, ...argv);
        expect(code).toBe(exitCode);
        expect(body).toMatchObject({
          ok: false,
          data: null,
          error: {
            code: refused,
            message: answer.error.message,
            details: { status: Number(status), ...answer.error.details },
          },
        });
      }
      expect(calls).toHaveLength(2);
    },
  );
});

describe("pidgen domain epics", () => {
  it("calls GET /domains/{domain_id}/epics and prints the Epics, their project groups and hidden counts", async () => {
    const { ctx, calls } = await setup({
      respond: () => ok(200, BOARD, { page: 1, per_page: 10, total: 1 }),
    });
    const { code, body } = await run(ctx, "domain", "epics", "PAY");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: BOARD, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(route(calls[0])).toEqual(["GET", "/api/v1/domains/PAY/epics"]);
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });

    const data = body.data as typeof BOARD;
    expect(data.epics[0]).toMatchObject({
      epic: { kind: "epic" },
      domain_id: DOMAIN_IDS.pay,
      hidden: 2,
    });
    expect(data.epics[0]?.projects.map((group) => group.project.key)).toEqual(["ALPHA", "BETA"]);
    const named = data.epics.flatMap((entry) =>
      entry.projects.flatMap((group) => group.ticket_ids),
    );
    expect(data.tickets.map((ticket) => ticket["id"])).toEqual(named);
  });

  it("sends --state, --page, --per-page and --no-subdomains as the query", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, BOARD) });
    const { code } = await run(
      ctx,
      "domain",
      "epics",
      "PAY",
      "--state",
      "finished",
      "--page",
      "2",
      "--per-page",
      "50",
      "--no-subdomains",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(route(calls[0])).toEqual([
      "GET",
      "/api/v1/domains/PAY/epics?state=finished&page=2&per_page=50&subdomains=false",
    ]);

    await run(ctx, "domain", "epics", "a/b", "--state", "open");
    expect(route(calls[1])).toEqual(["GET", "/api/v1/domains/a%2Fb/epics?state=open"]);
  });

  it.each([
    [["--state", "closed"]],
    [["--page", "0"]],
    [["--page", "two"]],
    [["--per-page", "51"]],
    [["--per-page", "0"]],
    [["--per-page", "1.5"]],
  ])("%j is a usage error (exit 2) and sends nothing", async (extra) => {
    const { ctx, calls } = await setup({ respond: () => ok(200, BOARD) });
    const { code, body } = await run(ctx, "domain", "epics", "PAY", ...extra);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(calls).toHaveLength(0);
  });

  it("a missing domain is a usage error (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, BOARD) });
    const { code } = await run(ctx, "domain", "epics");
    expect(code).toBe(ExitCode.Usage);
    expect(calls).toHaveLength(0);
  });

  it("an unknown domain exits 4 with the server's DOMAIN_NOT_FOUND", async () => {
    const answer = errorExample("DOMAIN_NOT_FOUND");
    const { ctx } = await setup({ respond: () => refusal(404, answer) });
    const { code, body } = await run(ctx, "domain", "epics", "NOPE");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({ code: "DOMAIN_NOT_FOUND", message: answer.error.message });
  });

  it.each([
    [{ ...BOARD, epics: [{ ...BOARD.epics[0], hidden: "two" }] }],
    [{ epics: [] }],
    [[BOARD]],
    // A board entry as the pending fragment stated it, before the published TicketResource
    // carried domain_epic.
    [{ ...BOARD, tickets: [{ ...BOARD.tickets[0], domain_epic: undefined }] }],
  ])(
    "a body that does not match the published document exits 1 with UNEXPECTED_RESPONSE",
    async (data) => {
      const { ctx } = await setup({ respond: () => ok(200, data) });
      const { code, body } = await run(ctx, "domain", "epics", "PAY");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error).toMatchObject({
        code: "UNEXPECTED_RESPONSE",
        details: { route: "GET /api/v1/domains/{domain_id}/epics" },
      });
    },
  );

  it("the fixtures are the published DomainEpicBoard and TicketResource", () => {
    expect(publishedIssues("DomainEpicBoard", BOARD)).toEqual([]);
    expect(publishedIssues("CreatedTicket", CREATED)).toEqual([]);
    expect(publishedIssues("PublicError", errorExample("DOMAIN_NOT_FOUND"))).toEqual([]);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: domain board at %s columns", async (columns) => {
  const { ctx, calls } = await setup({ respond: () => ok(200, BOARD) });
  ctx.io.stdoutColumns = columns;
  const argv = ["domain", "epics", DOMAIN_IDS.pay];
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
    "Initiatives",
    "Initiatives (1 displayed)",
    "PAY-12",
    "ALPHA",
    "BETA",
    "Hidden: 2",
    "Tickets (2 displayed)",
    "TKT-example-beta-7",
  ])
    expect(output).toContain(value);
  expect(output.split("\n")[0]).toBe("Initiatives");
  expect(output).not.toMatch(/Domain Epic|Account Epic/);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// A Domain Epic is called an Initiative wherever a person reads it; command names, flags and JSON
// are unchanged.
describe("Initiative: what a person reads about a Domain Epic", () => {
  it.each([
    ["ticket create --domain", ["ticket", "create", "--domain", "PAY", "-f"]],
    ["epic create --domain", ["epic", "create", "--domain", "PAY", "-f"]],
  ])("%s confirms Initiative <key> created, and its JSON is unchanged", async (_, argv) => {
    const { ctx } = await setup();
    ctx.io.stdoutColumns = 80;
    const name = await file(ctx, "epic.json", DOMAIN_EPIC);
    const { code, body } = await run(ctx, ...argv, name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: CREATED, error: null, meta: META });

    ctx.out.length = 0;
    expect(await runCli([...argv, name, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    const output = ctx.out.join("");
    expect(output).toContain("Initiative COM-12 created.");
    expect(output).toContain("COM-12");
    expect(output).toContain(DOMAIN_EPIC.title);
    expect(output).not.toMatch(/Domain Epic|Account Epic/);
  });

  it("a Project Epic's create does not say Initiative", async () => {
    const { ctx } = await setup();
    const name = await file(ctx, "epic.json", { ...DOMAIN_EPIC, project_id: "ALPHA" });
    expect(await runCli(["epic", "create", "-f", name, "--format", "table"], ctx)).toBe(
      ExitCode.Ok,
    );
    expect(ctx.out.join("")).not.toContain("Initiative");
  });

  it("the CLI's own refusals of an Initiative's file say Initiative", async () => {
    const { ctx } = await setup();
    const name = await file(ctx, "epic.json", DOMAIN_EPIC);
    const kind = await run(
      ctx,
      "ticket",
      "create",
      "--kind",
      "story",
      "--domain",
      "PAY",
      "-f",
      name,
    );
    expect(kind.body.error?.message).toBe("--domain files an Initiative, which is not a story.");

    const named = await file(ctx, "named.json", { ...DOMAIN_EPIC, project_id: "ALPHA" });
    const field = await run(ctx, "epic", "create", "--domain", "PAY", "-f", named);
    expect(field.body.error).toMatchObject({
      code: "INPUT_INVALID",
      message: "An Initiative's file may not name project_id.",
      details: {
        issues: [
          {
            path: "$.project_id",
            message:
              "Remove project_id: an Initiative is filed in the domain's home and owns no branch.",
          },
        ],
      },
    });
  });

  it.each([
    [["ticket", "create", "--help"]],
    [["epic", "create", "--help"]],
    [["domain", "epics", "--help"]],
  ])("%j says Initiative, never Domain Epic, and keeps its flags", async (argv) => {
    const ctx = await testContext();
    expect(await runCli(argv, ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    expect(help).toContain("Initiative");
    expect(help).not.toMatch(/Domain Epic|Account Epic/);
    expect(help).toContain(argv[0] === "domain" ? "--no-subdomains" : "--domain <domain>");
  });

  it("the ticket noun's summaries say Initiative", async () => {
    const ctx = await testContext();
    expect(await runCli(["ticket", "--help"], ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    expect(help).toContain("--domain an Initiative");
    expect(help).not.toMatch(/Domain Epic|Account Epic/);
  });
});
