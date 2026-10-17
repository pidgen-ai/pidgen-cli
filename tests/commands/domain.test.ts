import { expectMutationParity } from "../support/context.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import {
  DOMAIN_DETAIL,
  DOMAIN_LIST,
  OTHER_USER_ID,
  publicError,
  publishedIssues,
  USER_ID,
} from "../support/published.js";

// The pidgen domain commands with a fake fetch answering fixtures shaped by the published document
// (tests/support/published.ts, checked against contracts/openapi.json): routes, request bodies,
// data, refusals and usage errors.

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

const LIST = DOMAIN_LIST;
const PAY = DOMAIN_DETAIL;

/** A refusal in the public error shape, as the published route's response states it. */
function errorExample(code: string, details: Record<string, unknown> | null = null) {
  return publicError(code, `The server refuses: ${code}.`, details);
}

function ok(data: unknown) {
  return jsonResponse(
    200,
    { status: "ok", data, meta: null },
    { "x-request-id": "req_fake_ok", "pidgen-api-version": "1.0" },
  );
}

function refusal(status: number, body: unknown) {
  return jsonResponse(status, body, { "x-request-id": "req_fake_error" });
}

async function setup(options: { respond?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? (() => ok(PAY));
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

describe("pidgen domain list and show", () => {
  it("list calls GET /domains and prints the server's domains, the Account domain first", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(LIST) });
    const { code, body } = await run(ctx, "domain", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: LIST, error: null, meta: META });
    expect(LIST[0]).toMatchObject({ is_account_root: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: `${SERVER}/api/v1/domains`,
      body: undefined,
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("show calls GET /domains/{domain_id} with the key or id as one encoded segment", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "domain", "show", "PAY");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: PAY, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${SERVER}/api/v1/domains/PAY` });

    await run(ctx, "domain", "show", "a/b c");
    expect(calls[1]?.url).toBe(`${SERVER}/api/v1/domains/a%2Fb%20c`);
  });

  it("show of an unknown domain exits 4 with the server's DOMAIN_NOT_FOUND", async () => {
    const answer = errorExample("DOMAIN_NOT_FOUND");
    const { ctx } = await setup({ respond: () => refusal(404, answer) });
    const { code, body } = await run(ctx, "domain", "show", "NOPE");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "DOMAIN_NOT_FOUND", message: answer.error.message, details: { status: 404 } },
    });
  });

  it.each([
    ["list", ["domain", "list"], [{ id: "dom-example-root", key: "EXMPL" }]],
    ["list", ["domain", "list"], { not: "a list" }],
    // The fragment's flat members and maintainers counts are nested under people when published.
    ["list", ["domain", "list"], [{ ...LIST[0], people: undefined, members: 0, maintainers: 2 }]],
    ["show", ["domain", "show", "PAY"], { ...PAY, people: { members: "three", maintainers: 1 } }],
    ["show", ["domain", "show", "PAY"], { ...PAY, granted: undefined }],
    ["show", ["domain", "show", "PAY"], null],
  ])(
    "%s answered with a body that does not match the published document exits 1 with UNEXPECTED_RESPONSE",
    async (_name, argv, data) => {
      const { ctx } = await setup({ respond: () => ok(data) });
      const { code, body } = await run(ctx, ...argv);
      expect(code).toBe(ExitCode.Unexpected);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNEXPECTED_RESPONSE" } });
      expect(body.error?.details["route"]).toMatch(/^GET \/api\/v1\/domains/);
      expect((body.error?.details["issues"] as unknown[]).length).toBeGreaterThan(0);
    },
  );

  it("a write answered with a body that does not match the published document exits 1", async () => {
    const { ctx } = await setup({ respond: () => ok({ id: "dom-example-pay" }) });
    const { code, body } = await run(ctx, "domain", "archive", "PAY");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      details: { route: "PATCH /api/v1/domains/{domain_id}" },
    });
  });
});

describe("pidgen domain writes", () => {
  const created = { ...PAY, key: "CARDS", name: "Cards", granted: [] };
  const edited = PAY;

  it.each([
    [
      "create",
      ["domain", "create", "--name", "Cards", "--key", "CARDS"],
      "POST",
      "/domains",
      { name: "Cards", key: "CARDS" },
      created,
    ],
    [
      "create with parents",
      [
        "domain",
        "create",
        "--name",
        "Cards",
        "--key",
        "CARDS",
        "--parent",
        "PAY",
        "--parent",
        "dom-example-fin",
      ],
      "POST",
      "/domains",
      { name: "Cards", key: "CARDS", parent_ids: ["PAY", "dom-example-fin"] },
      created,
    ],
    [
      "edit --name",
      ["domain", "edit", "PAY", "--name", "Payments and billing"],
      "PATCH",
      "/domains/PAY",
      { name: "Payments and billing" },
      edited,
    ],
    [
      "edit --name --key",
      ["domain", "edit", "PAY", "--name", "Billing", "--key", "BILL"],
      "PATCH",
      "/domains/PAY",
      { name: "Billing", key: "BILL" },
      edited,
    ],
    ["archive", ["domain", "archive", "PAY"], "PATCH", "/domains/PAY", { archived: true }, edited],
    [
      "unarchive",
      ["domain", "unarchive", "PAY"],
      "PATCH",
      "/domains/PAY",
      { archived: false },
      edited,
    ],
    [
      "project add",
      ["domain", "project", "add", "PAY", "ALPHA"],
      "PUT",
      "/domains/PAY/projects/ALPHA",
      undefined,
      PAY,
    ],
    [
      "project rm",
      ["domain", "project", "rm", "PAY", "ALPHA"],
      "DELETE",
      "/domains/PAY/projects/ALPHA",
      undefined,
      PAY,
    ],
    [
      "parent add",
      ["domain", "parent", "add", "PAY", "FIN"],
      "PUT",
      "/domains/PAY/parents/FIN",
      undefined,
      PAY,
    ],
    [
      "parent rm",
      ["domain", "parent", "rm", "PAY", "FIN"],
      "DELETE",
      "/domains/PAY/parents/FIN",
      undefined,
      PAY,
    ],
    [
      "member add",
      ["domain", "member", "add", "PAY", USER_ID],
      "PUT",
      `/domains/PAY/people/${USER_ID}`,
      { role: "member" },
      PAY,
    ],
    [
      "member rm",
      ["domain", "member", "rm", "PAY", USER_ID],
      "DELETE",
      `/domains/PAY/people/${USER_ID}`,
      undefined,
      PAY,
    ],
    [
      "maintainer add",
      ["domain", "maintainer", "add", "PAY", USER_ID],
      "PUT",
      `/domains/PAY/people/${USER_ID}`,
      { role: "maintainer" },
      PAY,
    ],
    [
      "maintainer rm",
      ["domain", "maintainer", "rm", "PAY", USER_ID],
      "PUT",
      `/domains/PAY/people/${USER_ID}`,
      { role: "member" },
      PAY,
    ],
  ])(
    "%s sends one request with its method, path and body",
    async (_name, argv, method, path, sent, data) => {
      const { ctx, calls } = await setup({ respond: () => ok(data) });
      const { code, body } = await run(ctx, ...argv);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toEqual({ ok: true, data, error: null, meta: META });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        method,
        url: `${SERVER}/api/v1${path}`,
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          "x-pidgen-account": "ACC-EXAMPLE",
        }) as unknown,
        body: sent,
      });
    },
  );

  it("encodes each path segment of a write", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "domain", "member", "add", "a/b", "usr example");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url).toBe(`${SERVER}/api/v1/domains/a%2Fb/people/usr%20example`);
  });
});

describe("pidgen domain refusals", () => {
  // The details the published routes state for a refusal.
  const DETAILS: Record<string, Record<string, unknown>> = {
    DOMAIN_COVERAGE_IN_USE: { ticket_keys: ["ALPHA-12", "ALPHA-14"], hidden_count: 2 },
    DOMAIN_HAS_OPEN_EPICS: { ticket_keys: ["PAY-12"] },
  };

  it.each([
    [
      "DOMAIN_CYCLE",
      ["domain", "parent", "add", "PAY", "CARDS"],
      "put",
      "/domains/{domain_id}/parents/{parent_id}",
    ],
    [
      "DOMAIN_TOO_DEEP",
      ["domain", "parent", "add", "CARDS", "PAY"],
      "put",
      "/domains/{domain_id}/parents/{parent_id}",
    ],
    ["DOMAIN_IS_ACCOUNT_ROOT", ["domain", "archive", "EXMPL"], "patch", "/domains/{domain_id}"],
    [
      "DOMAIN_COVERAGE_IN_USE",
      ["domain", "project", "rm", "PAY", "ALPHA"],
      "delete",
      "/domains/{domain_id}/projects/{project_ref}",
    ],
    [
      "DOMAIN_COVERAGE_IN_USE",
      ["domain", "parent", "rm", "PAY", "EXMPL"],
      "delete",
      "/domains/{domain_id}/parents/{parent_id}",
    ],
    ["DOMAIN_HAS_OPEN_EPICS", ["domain", "archive", "PAY"], "patch", "/domains/{domain_id}"],
  ])(
    "%s exits 5 with the server's code, message and details, whatever the status (%j)",
    async (refused, argv, method, path) => {
      const answer = errorExample(refused, DETAILS[refused] ?? null);
      expect(method).toMatch(/^(put|patch|delete)$/);
      expect(path).toMatch(/^\/domains\//);
      for (const status of [409, 422]) {
        const { ctx, calls } = await setup({ respond: () => refusal(status, answer) });
        const { code, body } = await run(ctx, ...argv);
        expect(code, `${status}`).toBe(ExitCode.Refused);
        expect(body).toMatchObject({
          ok: false,
          data: null,
          error: {
            code: refused,
            message: answer.error.message,
            details: { status, request_id: "req_example", ...answer.error.details },
          },
        });
        expect(calls).toHaveLength(1);
      }
    },
  );

  it("DOMAIN_COVERAGE_IN_USE carries the work it names and the hidden count", async () => {
    const answer = errorExample("DOMAIN_COVERAGE_IN_USE", DETAILS["DOMAIN_COVERAGE_IN_USE"]);
    const { ctx } = await setup({ respond: () => refusal(409, answer) });
    const { code, body } = await run(ctx, "domain", "project", "rm", "PAY", "ALPHA");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.details).toMatchObject({
      ticket_keys: ["ALPHA-12", "ALPHA-14"],
      hidden_count: 2,
    });
  });

  it("DOMAIN_HAS_OPEN_EPICS carries the Epics it names", async () => {
    const answer = errorExample("DOMAIN_HAS_OPEN_EPICS", DETAILS["DOMAIN_HAS_OPEN_EPICS"]);
    const { ctx } = await setup({ respond: () => refusal(409, answer) });
    const { code, body } = await run(ctx, "domain", "archive", "PAY");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.details).toMatchObject({ ticket_keys: ["PAY-12"] });
  });

  it.each([
    ["DOMAIN_NOT_FOUND", ["domain", "edit", "NOPE", "--name", "X"], "get", "/domains/{domain_id}"],
    [
      "DOMAIN_NOT_FOUND",
      ["domain", "project", "add", "NOPE", "ALPHA"],
      "put",
      "/domains/{domain_id}/projects/{project_ref}",
    ],
    [
      "MEMBER_NOT_FOUND",
      ["domain", "member", "add", "PAY", OTHER_USER_ID],
      "put",
      "/domains/{domain_id}/people/{user_id}",
    ],
    [
      "MEMBER_NOT_FOUND",
      ["domain", "maintainer", "rm", "PAY", OTHER_USER_ID],
      "put",
      "/domains/{domain_id}/people/{user_id}",
    ],
  ])("%s exits 4 with the server's code and message", async (missing, argv, _method, _path) => {
    const answer = errorExample(missing);
    const { ctx } = await setup({ respond: () => refusal(404, answer) });
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({ code: missing, message: answer.error.message });
  });

  it("a duplicate key (409) exits 5 with the server's code", async () => {
    const answer = errorExample("DOMAIN_KEY_TAKEN", { key: "PAY" });
    const { ctx } = await setup({ respond: () => refusal(409, answer) });
    const { code, body } = await run(ctx, "domain", "create", "--name", "Pay", "--key", "PAY");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "DOMAIN_KEY_TAKEN",
      message: answer.error.message,
      details: { status: 409, key: "PAY" },
    });
  });

  it.each(["ENTITLEMENT_LIMIT_REACHED", "FEATURE_NOT_IN_PLAN"])(
    "the switched-off feature (403 %s) exits 3 with the code passed through",
    async (switchedOff) => {
      const answer = errorExample("ENTITLEMENT_LIMIT_REACHED");
      const body403 = { ...answer, error: { ...answer.error, code: switchedOff } };
      const { ctx } = await setup({ respond: () => refusal(403, body403) });
      const { code, body } = await run(
        ctx,
        "domain",
        "create",
        "--name",
        "Cards",
        "--key",
        "CARDS",
      );
      expect(code).toBe(ExitCode.Auth);
      expect(body.error).toMatchObject({ code: switchedOff, message: answer.error.message });
    },
  );
});

describe("pidgen domain usage errors", () => {
  it.each([
    [["domain", "show"]],
    [["domain", "show", ""]],
    [["domain", "show", ".."]],
    [["domain", "show", "PAY", "CARDS"]],
    [["domain", "list", "PAY"]],
    [["domain", "create"]],
    [["domain", "create", "--name", "Cards"]],
    [["domain", "create", "--key", "CARDS"]],
    [["domain", "create", "--name", " ", "--key", "CARDS"]],
    [["domain", "create", "--name", "Cards", "--key", ""]],
    [["domain", "create", "--name", "Cards", "--key", "CARDS", "--parent", ""]],
    [["domain", "edit"]],
    [["domain", "edit", "PAY"]],
    [["domain", "edit", "PAY", "--name", ""]],
    [["domain", "archive"]],
    [["domain", "unarchive"]],
    [["domain", "project", "add", "PAY"]],
    [["domain", "project", "rm"]],
    [["domain", "parent", "add", "PAY"]],
    [["domain", "parent", "rm", "PAY", "."]],
    [["domain", "member", "add", "PAY"]],
    [["domain", "member", "rm"]],
    [["domain", "maintainer", "add", "PAY"]],
    [["domain", "maintainer", "rm", "PAY", ""]],
  ])("%j is a usage error (exit 2) and sends nothing", async (argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [["domain", "create", "--name", "Cards", "--key", "cards"]],
    [["domain", "create", "--name", "Cards", "--key", "TOOLONGKEY"]],
    [["domain", "edit", "PAY", "--key", "P"]],
  ])(
    "%j is sent, as the published request states no key pattern, and the server's DOMAIN_KEY_INVALID exits 2",
    async (argv) => {
      const answer = errorExample("DOMAIN_KEY_INVALID");
      const { ctx, calls } = await setup({ respond: () => refusal(422, answer) });
      const { code, body } = await run(ctx, ...argv);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error).toMatchObject({
        code: "DOMAIN_KEY_INVALID",
        message: answer.error.message,
        details: { status: 422 },
      });
      expect(calls).toHaveLength(1);
    },
  );
});

describe("the fixtures are the published shapes", () => {
  it("each domain fixture matches the published DomainResource or DomainDetail", () => {
    for (const domain of LIST) expect(publishedIssues("DomainResource", domain)).toEqual([]);
    expect(publishedIssues("DomainDetail", PAY)).toEqual([]);
    // The people counts are nested under people, as the published resource states them.
    expect(PAY.people).toEqual({ members: 3, maintainers: 1 });
    expect(PAY).not.toHaveProperty("members");
    expect(publishedIssues("PublicError", errorExample("DOMAIN_NOT_FOUND"))).toEqual([]);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [domain, list] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({ respond: () => ok(LIST) });
    ctx.io.stdoutColumns = columns;
    const argv = ["domain", "list"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Domains", "Archived", "false"]) expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [domain, show, PAY] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["domain", "show", "PAY"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Domain", "Maintainers", "Projects"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);

it.each([40, 80, 120])("domain mutations preserve direct writes at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  await expectMutationParity(
    ctx,
    calls,
    ["domain", "edit", "PAY", "--name", "Payments and billing"],
    ["domain edit", "Payments"],
  );
  expect(calls.length).toBeGreaterThan(0);
});
