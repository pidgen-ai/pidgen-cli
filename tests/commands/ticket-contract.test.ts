import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import { contractLink, publicError, publishedIssues } from "../support/published.js";

// pidgen ticket contract implements | builds-against | rm with a fake fetch answering fixtures
// shaped by the published document (tests/support/published.ts): the link routes, their bodies,
// the Ticket's contracts they print, the seven link refusals and the usage errors.

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> | null } | null;
  meta: Record<string, unknown>;
}

interface Call {
  url: string;
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

/** The status and refusal body the published link routes state for `code`. */
function errorExample(code: string) {
  const status = STATUSES[code];
  if (status === undefined) throw new Error(`no status for ${code}`);
  return {
    status,
    body: publicError(code, `The server refuses: ${code}.`, DETAILS[code] ?? null),
  };
}

/** The status each refusal answers with, as the published link routes state it. */
const STATUSES: Record<string, number> = {
  CONTRACT_LINK_NOT_DELIVERY_ROOT: 422,
  CONTRACT_LINK_OUTSIDE_PROVIDER: 422,
  CONTRACT_LINK_OWN_PROVIDER: 422,
  CONTRACT_LINK_INSIDE_COHORT: 422,
  CONTRACT_UNKNOWN_OPERATION: 422,
  CONTRACT_DEPRECATED: 409,
  CONTRACT_RETIRED: 409,
  TICKET_NOT_FOUND: 404,
  CONTRACT_NOT_FOUND: 404,
  CONTRACT_LINK_NOT_FOUND: 404,
  FORBIDDEN: 403,
};

/** The details each link refusal carries. */
const DETAILS: Record<string, Record<string, unknown>> = {
  CONTRACT_LINK_NOT_DELIVERY_ROOT: { ticket_id: "ALPHA-40" },
  CONTRACT_LINK_OUTSIDE_PROVIDER: { provider_project_id: "proj-example-a" },
  CONTRACT_LINK_OWN_PROVIDER: { provider_project_id: "proj-example-a" },
  CONTRACT_LINK_INSIDE_COHORT: { delivery_root: "ALPHA-39" },
  CONTRACT_DEPRECATED: { replacement: "CT-8" },
  CONTRACT_RETIRED: { contract: "CT-7" },
  CONTRACT_UNKNOWN_OPERATION: { operations: ["DELETE /payments"] },
};

/** The Ticket's contracts after an implements link to CT-7 (with the criterion it adds). */
function implementsLinks(operations: string[]) {
  return { contracts: [contractLink({ operations })] };
}

/** The Ticket's contracts after a builds-against link to CT-7 (with no criterion). */
function buildsAgainstLinks(operations: string[]) {
  return {
    contracts: [contractLink({ link: "builds_against", operations, criterion_id: null })],
  };
}

/** The Ticket's contracts after its link to CT-7 is removed: another link stays. */
const REMOVED = {
  contracts: [
    contractLink({
      contract_id: "CTR-example-4",
      key: "CT-4",
      title: "Ledger library",
      provider_project_id: "proj-example-c",
      link: "builds_against",
      criterion_id: null,
    }),
  ],
};

function ok(data: unknown, status = 200) {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": "req_fake_ok", "pidgen-api-version": "1.0" },
  );
}

function refusal(status: number, body: unknown) {
  return jsonResponse(status, body, { "x-request-id": "req_fake_error" });
}

/** Answers the link routes with the Ticket's contracts, echoing what the request named. */
function byRoute(call: Call): Response {
  const path = new URL(call.url).pathname;
  if (call.method === "POST" && /^\/api\/v1\/tickets\/[^/]+\/contracts$/.test(path)) {
    const body = call.body as { link: string; operations: string[] };
    const links = body.link === "implements" ? implementsLinks : buildsAgainstLinks;
    return ok(links(body.operations), 201);
  }
  if (call.method === "DELETE" && /^\/api\/v1\/tickets\/[^/]+\/contracts\/[^/]+$/.test(path)) {
    return ok(REMOVED);
  }
  throw new Error(`unexpected ${call.method} ${path}`);
}

async function setup(options: { respond?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? byRoute;
  const ctx = await testContext({
    fetch: (input, init) => {
      const text = init?.body;
      const call: Call = {
        url: String(input),
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

describe("pidgen ticket contract implements and builds-against", () => {
  it("implements sends POST /tickets/{ticket_id}/contracts with the link and prints the Ticket's contracts, with the criterion it adds", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "contract",
      "implements",
      "ALPHA-40",
      "CT-7",
      "--operation",
      "POST /payments/{id}/refund",
      "--operation",
      "GET /payments",
    );
    expect(code).toBe(ExitCode.Ok);
    const operations = ["POST /payments/{id}/refund", "GET /payments"];
    expect(body).toEqual({ ok: true, data: implementsLinks(operations), error: null, meta: META });
    expect(body.data).toMatchObject({
      contracts: [{ key: "CT-7", link: "implements", criterion_id: expect.any(String) }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/tickets/ALPHA-40/contracts`,
      body: { contract_id: "CT-7", link: "implements", operations },
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("builds-against sends link builds_against and prints the Ticket's contracts, with no criterion", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "contract",
      "builds-against",
      "BETA-12",
      "CT-7",
      "--operation",
      "GET /payments",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: buildsAgainstLinks(["GET /payments"]),
      error: null,
      meta: META,
    });
    expect(body.data).toMatchObject({
      contracts: [{ link: "builds_against", criterion_id: null }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/tickets/BETA-12/contracts`,
      body: { contract_id: "CT-7", link: "builds_against", operations: ["GET /payments"] },
    });
  });

  it.each([["implements"], ["builds-against"]])(
    "%s with no --operation sends an empty operations list (all of them)",
    async (verb) => {
      const { ctx, calls } = await setup();
      const { code } = await run(ctx, "ticket", "contract", verb, "ALPHA-40", "CT-7");
      expect(code).toBe(ExitCode.Ok);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toEqual({
        contract_id: "CT-7",
        link: verb === "implements" ? "implements" : "builds_against",
        operations: [],
      });
    },
  );

  it("percent-encodes the ticket ref as one path segment", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "ticket", "contract", "implements", "a/b c", "CT-7");
    expect(calls[0]?.url).toBe(`${SERVER}/api/v1/tickets/a%2Fb%20c/contracts`);
  });

  it.each([
    [{ link: "implements" }],
    // The link as the pending fragment stated it, not the published Ticket's contracts.
    [
      {
        ticket_id: "TKT-example-40",
        contract_id: "ctr-example-7",
        contract_key: "CT-7",
        link: "implements",
        operations: [],
        criterion_id: "AC-example-implements-ct-7",
        created_at: "2026-10-14T09:10:00Z",
      },
    ],
  ])(
    "a link answer that does not match the published document exits 1 with UNEXPECTED_RESPONSE",
    async (data) => {
      const { ctx } = await setup({ respond: () => ok(data, 201) });
      const { code, body } = await run(ctx, "ticket", "contract", "implements", "ALPHA-40", "CT-7");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error).toMatchObject({
        code: "UNEXPECTED_RESPONSE",
        details: { route: "POST /api/v1/tickets/{ticket_id}/contracts" },
      });
    },
  );
});

describe("pidgen ticket contract rm", () => {
  it("sends DELETE /tickets/{ticket_id}/contracts/{contract_id} and prints the Ticket's remaining contracts", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "contract", "rm", "ALPHA-40", "CT-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: REMOVED, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `${SERVER}/api/v1/tickets/ALPHA-40/contracts/CT-7`,
      body: undefined,
    });

    await run(ctx, "ticket", "contract", "rm", "a/b", "CT 7");
    expect(calls[1]?.url).toBe(`${SERVER}/api/v1/tickets/a%2Fb/contracts/CT%207`);
  });

  it("no such link exits 4 with the server's CONTRACT_LINK_NOT_FOUND", async () => {
    const answer = errorExample("CONTRACT_LINK_NOT_FOUND");
    const { ctx } = await setup({ respond: () => refusal(answer.status, answer.body) });
    const { code, body } = await run(ctx, "ticket", "contract", "rm", "ALPHA-40", "CT-9");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({
      code: "CONTRACT_LINK_NOT_FOUND",
      message: answer.body.error.message,
    });
  });

  it("a removal answer that does not match the published document exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({ respond: () => ok(null) });
    const { code, body } = await run(ctx, "ticket", "contract", "rm", "ALPHA-40", "CT-7");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      details: { route: "DELETE /api/v1/tickets/{ticket_id}/contracts/{contract_id}" },
    });
  });
});

describe("the link refusals", () => {
  const REFUSALS = [
    "CONTRACT_LINK_NOT_DELIVERY_ROOT",
    "CONTRACT_LINK_OUTSIDE_PROVIDER",
    "CONTRACT_LINK_OWN_PROVIDER",
    "CONTRACT_LINK_INSIDE_COHORT",
    "CONTRACT_DEPRECATED",
    "CONTRACT_RETIRED",
    "CONTRACT_UNKNOWN_OPERATION",
  ];

  it.each(REFUSALS)(
    "%s exits 5 with the server's code, message and details, whatever its status",
    async (refused) => {
      const answer = errorExample(refused);
      expect(answer.body.error.details).not.toBeNull();
      for (const status of [answer.status, 400, 403, 404, 409, 422]) {
        const { ctx, calls } = await setup({ respond: () => refusal(status, answer.body) });
        const verb = refused === "CONTRACT_LINK_OWN_PROVIDER" ? "builds-against" : "implements";
        const { code, body } = await run(ctx, "ticket", "contract", verb, "ALPHA-40", "CT-7");
        expect(code, `${status} ${refused}`).toBe(ExitCode.Refused);
        expect(body).toMatchObject({ ok: false, data: null });
        expect(body.error).toMatchObject({
          code: refused,
          message: answer.body.error.message,
          details: answer.body.error.details,
        });
        expect(calls).toHaveLength(1);
      }
    },
  );

  it("an unknown ticket or contract exits 4, and a 403 exits 3", async () => {
    for (const [refused, exit] of [
      ["TICKET_NOT_FOUND", ExitCode.NotFound],
      ["CONTRACT_NOT_FOUND", ExitCode.NotFound],
      ["FORBIDDEN", ExitCode.Auth],
    ] as const) {
      const answer = errorExample(refused);
      const { ctx } = await setup({ respond: () => refusal(answer.status, answer.body) });
      const { code, body } = await run(ctx, "ticket", "contract", "implements", "ALPHA-40", "CT-7");
      expect(code, refused).toBe(exit);
      expect(body.error).toMatchObject({ code: refused, message: answer.body.error.message });
    }
  });
});

describe("pidgen ticket contract usage errors", () => {
  it.each([
    ["implements with no ticket", ["ticket", "contract", "implements"]],
    ["implements with no contract", ["ticket", "contract", "implements", "ALPHA-40"]],
    ["implements with an empty ticket", ["ticket", "contract", "implements", "", "CT-7"]],
    ["implements with a .. ticket", ["ticket", "contract", "implements", "..", "CT-7"]],
    ["implements with an empty contract", ["ticket", "contract", "implements", "ALPHA-40", " "]],
    [
      "implements with an empty --operation",
      ["ticket", "contract", "implements", "ALPHA-40", "CT-7", "--operation", ""],
    ],
    [
      "implements with a blank --operation among others",
      [
        "ticket",
        "contract",
        "implements",
        "ALPHA-40",
        "CT-7",
        "--operation",
        "GET /payments",
        "--operation",
        "  ",
      ],
    ],
    ["implements with an extra argument", ["ticket", "contract", "implements", "A-1", "CT-7", "x"]],
    ["builds-against with no ticket", ["ticket", "contract", "builds-against"]],
    ["builds-against with no contract", ["ticket", "contract", "builds-against", "BETA-12"]],
    [
      "builds-against with an empty --operation",
      ["ticket", "contract", "builds-against", "BETA-12", "CT-7", "--operation", ""],
    ],
    ["rm with no ticket", ["ticket", "contract", "rm"]],
    ["rm with no contract", ["ticket", "contract", "rm", "ALPHA-40"]],
    ["rm with an empty contract", ["ticket", "contract", "rm", "ALPHA-40", ""]],
    ["rm with a . contract", ["ticket", "contract", "rm", "ALPHA-40", "."]],
    [
      "rm with an --operation",
      ["ticket", "contract", "rm", "ALPHA-40", "CT-7", "--operation", "x"],
    ],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("the fixtures are the published shapes", () => {
  it("each answer matches the published TicketContractsResource", () => {
    for (const data of [implementsLinks([]), buildsAgainstLinks(["GET /payments"]), REMOVED]) {
      expect(publishedIssues("TicketContractsResource", data)).toEqual([]);
    }
    expect(publishedIssues("PublicError", errorExample("CONTRACT_RETIRED").body)).toEqual([]);
  });
});
