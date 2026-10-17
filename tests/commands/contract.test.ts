import { expectMutationParity } from "../support/context.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { FILE_REFUSALS } from "../../src/core/contract-publish.js";
import publishedDocument from "../../contracts/openapi.json" with { type: "json" };
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import {
  ACCEPTED as ACCEPTED_FIXTURE,
  CONTRACT as CONTRACT_FIXTURE,
  DOMAIN_CONTRACTS,
  DRY_RUN_ADDITIVE,
  DRY_RUN_BREAKING,
  OTHER_USER_ID,
  PROJECT_CONTRACTS,
  PROPOSED,
  publicError,
  PUBLISHED_CREATED,
  PUBLISHED_REVISED,
  PUBLISHED_UNCHANGED,
  publishedIssues,
  REVISED as REVISED_FIXTURE,
  USER_ID,
} from "../support/published.js";

// The pidgen contract commands with a fake fetch answering fixtures shaped by the published
// document (tests/support/published.ts): routes, request bodies, data, refusals and usage errors.

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
  /** A multipart body, as sent. */
  form?: FormData;
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

type Revision = Record<string, unknown> & { number: number; acceptance: string };
type Contract = Record<string, unknown> & { key: string; revisions: Revision[] };

const PROJECT_LIST = PROJECT_CONTRACTS as unknown as Record<string, unknown>;
const DOMAIN_LIST = DOMAIN_CONTRACTS as unknown as Record<string, unknown>;
const CONTRACT = CONTRACT_FIXTURE as unknown as Contract;
const REVISED = REVISED_FIXTURE as unknown as Contract;
const ACCEPTED = ACCEPTED_FIXTURE as unknown as Contract;

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

/** Answers each route with its fixture: the lists, the contract read, the revise and the accept. */
function byRoute(contract: unknown = CONTRACT) {
  return (call: Call): Response => {
    const path = new URL(call.url).pathname;
    if (call.method === "GET" && /^\/api\/v1\/projects\/[^/]+\/contracts$/.test(path)) {
      return ok(PROJECT_LIST);
    }
    if (call.method === "GET" && /^\/api\/v1\/domains\/[^/]+\/contracts$/.test(path)) {
      return ok(DOMAIN_LIST);
    }
    if (call.method === "GET" && /^\/api\/v1\/contracts\/[^/]+$/.test(path)) return ok(contract);
    if (call.method === "POST" && path.endsWith("/accept")) return ok(ACCEPTED);
    if (call.method === "POST" && path.endsWith("/revisions")) return ok(REVISED, 201);
    throw new Error(`unexpected ${call.method} ${path}`);
  };
}

async function setup(
  options: { respond?: (call: Call) => Response; env?: Record<string, string> } = {},
) {
  const calls: Call[] = [];
  const respond = options.respond ?? byRoute();
  const ctx = await testContext({
    env: options.env ?? {},
    fetch: (input, init) => {
      const text = init?.body;
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
        ...(text instanceof FormData ? { form: text } : {}),
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
  await mkdir(dirname(join(ctx.cwd, name)), { recursive: true });
  await writeFile(join(ctx.cwd, name), text);
  return name;
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

// The publish and proposal answers are the fixtures in tests/support/published.ts, each checked
// against the published document.

/** Answers every request with `data`, as a publish or proposal route answers. */
function published(data: unknown) {
  return (): Response => ok(data);
}

/** A refused file in the public error shape, its errors and refusal id in details. */
function fileRefusal(code: string, refusalId: string | null = "CPR-example-1") {
  return {
    status: "error",
    error: {
      code,
      message: `The server refuses the file: ${code}.`,
      details: {
        errors: [
          {
            message: "Path parameter 'id' is not declared.",
            location: "/paths/~1payments~1{id}/get",
          },
          { message: "Unexpected end of the document.", location: null },
          { message: "Unresolvable $ref.", location: "schemas/payment.json#/properties/x" },
        ],
        refusal_id: refusalId,
      },
      request_id: "req_fake_error",
    },
  };
}

/**
 * A repository at <home>/repo with an entry spec and the files beside it, one outside its
 * directory, and files that are not sent: a Markdown file and anything under node_modules or a dot
 * directory.
 */
async function repository(ctx: TestContext): Promise<string> {
  await file(ctx, "repo/.git/HEAD", "ref: refs/heads/main\n");
  await file(ctx, "repo/contracts/payments/openapi.yaml", SPEC_TEXT);
  await file(ctx, "repo/contracts/payments/common.yml", "components: {}\n");
  await file(ctx, "repo/contracts/payments/schemas/payment.json", { type: "object" });
  await file(ctx, "repo/contracts/payments/schemas/refund.yaml", "type: object\n");
  await file(ctx, "repo/contracts/payments/README.md", "# Payments\n");
  await file(ctx, "repo/contracts/payments/node_modules/x/package.json", {});
  await file(ctx, "repo/contracts/payments/.cache/old.json", {});
  await file(ctx, "repo/contracts/other.json", {});
  return "repo/contracts/payments/openapi.yaml";
}

const SPEC_TEXT = "openapi: 3.1.0\ninfo:\n  title: Payments\n  version: '1'\npaths: {}\n";

/** The name and text of every part named `field` in a multipart body. */
async function parts(form: FormData, field: string): Promise<Array<[string, string]>> {
  const found: Array<[string, string]> = [];
  for (const value of form.getAll(field)) {
    const part = value as File;
    found.push([part.name, await part.text()]);
  }
  return found;
}

describe("pidgen contract list", () => {
  it("--project calls GET /projects/{project_ref}/contracts and prints the server's lists", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "contract", "list", "--project", "ALPHA");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: PROJECT_LIST, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: `${SERVER}/api/v1/projects/ALPHA/contracts`,
      body: undefined,
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("--project prints the published Project list: provides and builds_against, no covered", async () => {
    const { ctx } = await setup();
    const { body } = await run(ctx, "contract", "list", "--project", "ALPHA");
    const data = body.data as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(data).sort()).toEqual(["builds_against", "provides"]);
    expect(data["provides"]?.[0]).toMatchObject({
      provider: { project_id: "proj-example-a", kind: "project", domain_id: null, key: "ALPHA" },
      owner_user_id: expect.any(String),
    });
  });

  it("--domain calls GET /domains/{domain_id}/contracts and prints its own, coverage and builds-against", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "contract", "list", "--domain", "PAY");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: DOMAIN_LIST, error: null, meta: META });
    expect((DOMAIN_LIST["coverage"] as unknown[]).length).toBeGreaterThan(0);
    expect((DOMAIN_LIST["own"] as Array<{ provider: unknown }>)[0]?.provider).toMatchObject({
      kind: "domain",
      domain_id: expect.any(String),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: `${SERVER}/api/v1/domains/PAY/contracts`,
    });

    await run(ctx, "contract", "list", "--domain", "a/b c");
    expect(calls[1]?.url).toBe(`${SERVER}/api/v1/domains/a%2Fb%20c/contracts`);
  });

  it.each([
    ["both flags", ["contract", "list", "--project", "ALPHA", "--domain", "PAY"]],
    ["neither flag", ["contract", "list"]],
    ["an empty --project", ["contract", "list", "--project", ""]],
    ["an empty --domain", ["contract", "list", "--domain", " "]],
    ["a --domain of ..", ["contract", "list", "--domain", ".."]],
    ["an extra argument", ["contract", "list", "--project", "ALPHA", "CT-7"]],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["--project", "ALPHA", "/projects/{project_ref}/contracts", "PROJECT_NOT_FOUND"],
    ["--domain", "NOPE", "/domains/{domain_id}/contracts", "DOMAIN_NOT_FOUND"],
  ])("%s of an unknown one exits 4 with the server's code", async (flag, value, _path, code_) => {
    const answer = errorExample(code_);
    const { ctx } = await setup({ respond: () => refusal(404, answer) });
    const { code, body } = await run(ctx, "contract", "list", flag, value);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({ code: code_, message: answer.error.message });
  });

  it.each([
    [{ provides: [] }],
    // A list entry as the pending fragment stated it: provider.id and owner, not the published
    // provider.project_id and owner_user_id.
    [
      {
        ...PROJECT_LIST,
        provides: [
          {
            id: "CTR-example-7",
            key: "CT-7",
            title: "Payments API",
            provider: { kind: "project", id: "proj-example-a", key: "ALPHA", name: "Alpha" },
            owner: { user_id: "usr-example-7", display_name: "Example Person" },
            status: "accepted",
            implemented: true,
          },
        ],
      },
    ],
  ])(
    "a list that does not match the published document exits 1 with UNEXPECTED_RESPONSE",
    async (data) => {
      const { ctx } = await setup({ respond: () => ok(data) });
      const { code, body } = await run(ctx, "contract", "list", "--project", "ALPHA");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error).toMatchObject({
        code: "UNEXPECTED_RESPONSE",
        details: { route: "GET /api/v1/projects/{project_ref}/contracts" },
      });
    },
  );
});

describe("pidgen contract show", () => {
  it("calls GET /contracts/{contract_id} and prints the contract, its revisions and its work, hidden work as counts, unchanged", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "contract", "show", "CT-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: CONTRACT, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${SERVER}/api/v1/contracts/CT-7` });
    // The fixture carries hidden work and every kind of acceptance; data keeps them as sent.
    const data = body.data as Contract & {
      built_against_by: { hidden_count: number };
      implemented_by: { hidden_count: number };
    };
    expect(data.built_against_by.hidden_count).toBeGreaterThan(0);
    expect(data.built_against_by).toEqual(CONTRACT["built_against_by"]);
    expect(data.implemented_by).toEqual(CONTRACT["implemented_by"]);
    expect(data.revisions.map((revision) => revision.acceptance)).toEqual([
      "automatic",
      "person",
      "waiting",
    ]);
    expect(data.revisions[1]).toMatchObject({ accepted_by: OTHER_USER_ID });
    expect(data).toMatchObject({
      owner_user_id: expect.any(String),
      provider: { project_id: "proj-example-a" },
    });
  });

  it("lists each operation's state: landed, pending, removed", async () => {
    const operation_states = [
      { name: "GET /payments", state: "landed" },
      { name: "POST /payments/{id}/refund", state: "pending" },
      { name: "DELETE /payments/{id}", state: "removed" },
    ];
    const contract = { ...CONTRACT, operation_states };
    expect(publishedIssues("ContractDetail", contract)).toEqual([]);
    const { ctx } = await setup({ respond: byRoute(contract) });
    const { code, body } = await run(ctx, "contract", "show", "CT-7");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(contract);
  });

  it("an operation state outside landed, pending and removed exits 1 with UNEXPECTED_RESPONSE", async () => {
    const operation_states = [{ name: "GET /payments", state: "shipped" }];
    const { ctx } = await setup({ respond: byRoute({ ...CONTRACT, operation_states }) });
    const { code, body } = await run(ctx, "contract", "show", "CT-7");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      details: { route: "GET /api/v1/contracts/{contract_id}" },
    });
  });

  it("an unknown contract exits 4 with the server's CONTRACT_NOT_FOUND", async () => {
    const answer = errorExample("CONTRACT_NOT_FOUND");
    const { ctx } = await setup({ respond: () => refusal(404, answer) });
    const { code, body } = await run(ctx, "contract", "show", "CT-99");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({ code: "CONTRACT_NOT_FOUND", message: answer.error.message });
  });

  it.each([
    [{ ...CONTRACT, revisions: [{ number: 1 }] }],
    [{ ...CONTRACT, built_against_by: { tickets: [], hidden: 0 } }],
    [{ ...CONTRACT, owner_user_id: undefined, owner: { user_id: "x", display_name: "X" } }],
    [null],
  ])(
    "a contract that does not match the published document exits 1 with UNEXPECTED_RESPONSE",
    async (data) => {
      const { ctx } = await setup({ respond: () => ok(data) });
      const { code, body } = await run(ctx, "contract", "show", "CT-7");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error).toMatchObject({
        code: "UNEXPECTED_RESPONSE",
        details: { route: "GET /api/v1/contracts/{contract_id}" },
      });
    },
  );

  it.each([
    [["contract", "show"]],
    [["contract", "show", ""]],
    [["contract", "show", "CT-7", "x"]],
  ])("%j is a usage error (exit 2) and sends nothing", async (argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen contract revise", () => {
  const REVISION = {
    kind: "rest",
    markdown: "# Payments API\n\nAdds reading one payment.\n",
    schema_format: "openapi",
    change: "additive",
    operations: [{ name: "GET /payments" }, { name: "GET /payments/{id}", types: ["Payment"] }],
  };

  it("sends POST /contracts/{contract_id}/revisions with the file's body and prints the contract with its new revision", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "revision.json", REVISION);
    const { code, body } = await run(ctx, "contract", "revise", "CT-7", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: REVISED, error: null, meta: META });
    expect(REVISED.revisions.at(-1)).toMatchObject({ number: 4, acceptance: "automatic" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/contracts/CT-7/revisions`,
      body: REVISION,
    });
  });

  it("reads a YAML body and --markdown's file into markdown, relative to the working directory", async () => {
    const waiting = {
      ...REVISED,
      revisions: REVISED.revisions.map((entry) =>
        entry.number === 4
          ? { ...entry, acceptance: "waiting", accepted_by: null, accepted_at: null }
          : entry,
      ),
    };
    const { ctx, calls } = await setup({ respond: () => ok(waiting, 201) });
    const name = await file(
      ctx,
      "revision.yaml",
      "kind: events\nchange: breaking\nschema_format: asyncapi\nnative_schema: 'asyncapi: 3.0.0'\n",
    );
    const markdown = "# Settlement events\n\nOne event per settled payment.\n";
    await file(ctx, "contract.md", markdown);
    const { code, body } = await run(
      ctx,
      "contract",
      "revise",
      "CT-9",
      "-f",
      name,
      "--markdown",
      "contract.md",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(waiting);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      kind: "events",
      change: "breaking",
      schema_format: "asyncapi",
      native_schema: "asyncapi: 3.0.0",
      markdown,
    });
  });

  it.each([
    ["no markdown", { kind: "rest", schema_format: "openapi", change: "additive" }, "$.markdown"],
    ["no schema format", { ...REVISION, schema_format: undefined }, "$.schema_format"],
    [
      "an operation as a bare string",
      { ...REVISION, operations: ["GET /payments"] },
      "$.operations[0]",
    ],
    ["an unknown kind", { ...REVISION, kind: "soap" }, "$.kind"],
    ["an unknown change", { ...REVISION, change: "minor" }, "$.change"],
    ["an unknown field", { ...REVISION, title: "Payments" }, "$"],
    ["an empty operation", { ...REVISION, operations: [{ name: "" }] }, "$.operations[0].name"],
    ["an unknown schema format", { ...REVISION, schema_format: "wsdl" }, "$.schema_format"],
  ])(
    "a body with %s is INPUT_INVALID (exit 2) and sends nothing",
    async (_name, revision, path) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "revision.json", revision);
      const { code, body } = await run(ctx, "contract", "revise", "CT-7", "-f", name);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error).toMatchObject({ code: "INPUT_INVALID" });
      expect(body.error?.details["issues"]).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("a body that does not parse is INPUT_INVALID (exit 2) and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "revision.json", "{ not json");
    const { code, body } = await run(ctx, "contract", "revise", "CT-7", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "INPUT_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no contract", () => ["contract", "revise"]],
    ["no -f", () => ["contract", "revise", "CT-7"]],
    ["a missing -f file", () => ["contract", "revise", "CT-7", "-f", "missing.json"]],
    [
      "a missing --markdown file",
      () => ["contract", "revise", "CT-7", "-f", "revision.json", "--markdown", "missing.md"],
    ],
    [
      "an empty --markdown file",
      () => ["contract", "revise", "CT-7", "-f", "revision.json", "--markdown", "empty.md"],
    ],
    [
      "markdown in the file and --markdown",
      () => ["contract", "revise", "CT-7", "-f", "full.json", "--markdown", "contract.md"],
    ],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup();
    await file(ctx, "revision.json", { ...REVISION, markdown: undefined });
    await file(ctx, "full.json", REVISION);
    await file(ctx, "contract.md", "# Text\n");
    await file(ctx, "empty.md", "");
    const { code, body } = await run(ctx, ...argv());
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(["CLI_USAGE", "INPUT_INVALID"]).toContain(body.error?.code);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["FORBIDDEN", "FORBIDDEN"],
    ["ENTITLEMENT_LIMIT_REACHED", "ENTITLEMENT_LIMIT_REACHED"],
    ["ENTITLEMENT_LIMIT_REACHED", "FEATURE_NOT_IN_PLAN"],
  ])("a 403 (%s as %s) exits 3 with the server's code", async (example_, sent) => {
    const answer = errorExample(example_);
    const { ctx } = await setup({
      respond: () => refusal(403, { ...answer, error: { ...answer.error, code: sent } }),
    });
    const name = await file(ctx, "revision.json", REVISION);
    const { code, body } = await run(ctx, "contract", "revise", "CT-9", "-f", name);
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({ code: sent, message: answer.error.message });
  });

  it("a revised contract that does not match the published document exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({ respond: () => ok({ number: 4 }, 201) });
    const name = await file(ctx, "revision.json", REVISION);
    const { code, body } = await run(ctx, "contract", "revise", "CT-7", "-f", name);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      details: { route: "POST /api/v1/contracts/{contract_id}/revisions" },
    });
  });
});

describe("pidgen contract accept", () => {
  it("without --revision reads the contract and accepts its one waiting revision", async () => {
    const waiting = CONTRACT.revisions.find((revision) => revision.acceptance === "waiting")!;
    expect(waiting).toBeDefined();
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "contract", "accept", "CT-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: ACCEPTED, error: null, meta: META });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${SERVER}/api/v1/contracts/CT-7`],
      ["POST", `${SERVER}/api/v1/contracts/CT-7/revisions/${waiting.number}/accept`],
    ]);
    expect(calls[1]?.body).toBeUndefined();
  });

  it("--revision accepts the named revision without reading the contract", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "contract", "accept", "CT-7", "--revision", "2");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(ACCEPTED);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${SERVER}/api/v1/contracts/CT-7/revisions/2/accept`],
    ]);
  });

  it("with no revision waiting exits 5 with NO_REVISION_WAITING and sends no accept", async () => {
    const settled = {
      ...CONTRACT,
      revisions: CONTRACT.revisions.map((revision) =>
        revision.acceptance === "waiting"
          ? { ...revision, acceptance: "automatic", accepted_at: "2026-10-14T09:00:00Z" }
          : revision,
      ),
    };
    const { ctx, calls } = await setup({ respond: byRoute(settled) });
    const { code, body } = await run(ctx, "contract", "accept", "CT-7");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NO_REVISION_WAITING" } });
    expect(body.error?.details).toMatchObject({
      contract: "CT-7",
      statuses: [
        { number: 1, acceptance: "automatic" },
        { number: 2, acceptance: "person" },
        { number: 3, acceptance: "automatic" },
      ],
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("with more than one revision waiting asks for --revision, exit 5, and sends no accept", async () => {
    const twice = {
      ...CONTRACT,
      revisions: CONTRACT.revisions.map((revision) => ({
        ...revision,
        acceptance: "waiting",
        accepted_by: null,
        accepted_at: null,
      })),
    };
    const { ctx, calls } = await setup({ respond: byRoute(twice) });
    const { code, body } = await run(ctx, "contract", "accept", "CT-7");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "REVISIONS_WAITING",
      details: { contract: "CT-7", waiting: [1, 2, 3] },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it.each([
    ["FORBIDDEN", "FORBIDDEN"],
    ["ENTITLEMENT_LIMIT_REACHED", "FEATURE_NOT_IN_PLAN"],
  ])("a 403 (%s as %s) from the server exits 3", async (example_, sent) => {
    const answer = errorExample(example_);
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? byRoute()(call)
          : refusal(403, { ...answer, error: { ...answer.error, code: sent } }),
    });
    const { code, body } = await run(ctx, "contract", "accept", "CT-7");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({ code: sent, message: answer.error.message });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it.each(["CONTRACT_REVISION_NOT_WAITING", "CONTRACT_REVISION_SUPERSEDED"])(
    "a revision that no longer waits is the server's %s (409, exit 5)",
    async (refused) => {
      const answer = errorExample(refused);
      const { ctx } = await setup({ respond: () => refusal(409, answer) });
      const { code, body } = await run(ctx, "contract", "accept", "CT-7", "--revision", "2");
      expect(code).toBe(ExitCode.Refused);
      expect(body.error).toMatchObject({ code: refused });
    },
  );

  it("an accepted contract that does not match the published document exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({ respond: () => ok({ number: "three" }) });
    const { code, body } = await run(ctx, "contract", "accept", "CT-7", "--revision", "3");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      details: {
        route: "POST /api/v1/contracts/{contract_id}/revisions/{revision_number}/accept",
      },
    });
  });

  it.each([
    [["contract", "accept"]],
    [["contract", "accept", ""]],
    [["contract", "accept", "CT-7", "--revision", "0"]],
    [["contract", "accept", "CT-7", "--revision", "two"]],
    [["contract", "accept", "CT-7", "--revision", "1.5"]],
    [["contract", "accept", "CT-7", "extra"]],
  ])("%j is a usage error (exit 2) and sends nothing", async (argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen contract create", () => {
  // The body and the answer are checked against the published document.
  const CREATED = {
    ...CONTRACT,
    key: "CT-12",
    number: 12,
    status: "accepted",
    newest_accepted_revision: 1,
    waiting_revisions: [],
    implemented: false,
    version: 1,
    revisions: [CONTRACT.revisions[0]!],
    implemented_by: { work: [], hidden_count: 0 },
    built_against_by: { work: [], hidden_count: 0 },
  } as Contract;
  const BODY = {
    title: "Payments API",
    kind: "rest",
    markdown: "# Payments API\n\nReads and takes payments.\n",
    schema_format: "prose",
    operations: [{ name: "GET /payments" }, { name: "POST /payments", types: ["Payment"] }],
  };
  const SPEC = "openapi: 3.1.0\ninfo:\n  title: Payments\n  version: '1'\npaths: {}\n";

  function created(call: Call): Response {
    const path = new URL(call.url).pathname;
    if (call.method === "POST" && /^\/api\/v1\/(projects|domains)\/[^/]+\/contracts$/.test(path)) {
      return ok(CREATED, 201);
    }
    throw new Error(`unexpected ${call.method} ${path}`);
  }

  it("--project sends POST /projects/{project_ref}/contracts with the file's body and prints the created contract", async () => {
    const { ctx, calls } = await setup({ respond: created });
    const name = await file(ctx, "contract.json", BODY);
    const { code, body } = await run(ctx, "contract", "create", "--project", "ALPHA", "-f", name);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: CREATED, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/projects/ALPHA/contracts`,
      body: BODY,
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("--domain sends POST /domains/{domain_id}/contracts", async () => {
    const { ctx, calls } = await setup({ respond: created });
    const name = await file(ctx, "contract.yaml", "title: Payments API\nkind: events\n");
    await file(ctx, "contract.md", "# Settlement events\n");
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--domain",
      "DOM-pay",
      "-f",
      name,
      "--schema-format",
      "asyncapi",
      "--markdown",
      "contract.md",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(CREATED);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/domains/DOM-pay/contracts`,
      body: {
        title: "Payments API",
        kind: "events",
        schema_format: "asyncapi",
        markdown: "# Settlement events\n",
      },
    });
  });

  it("--schema with --existing publishes the file instead of reading it into native_schema", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    await file(ctx, ".git/HEAD", "ref: refs/heads/main\n");
    await file(ctx, "payments.yaml", SPEC);
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--project",
      "ALPHA",
      "--title",
      "Payments API",
      "--schema-format",
      "openapi",
      "--schema",
      "payments.yaml",
      "--existing",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(PUBLISHED_CREATED);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/projects/ALPHA/contracts/publish`,
      body: undefined,
    });
    const form = calls[0]!.form!;
    expect(await (form.get("file") as File).text()).toBe(SPEC);
    expect(form.get("source_path")).toBe("payments.yaml");
    expect(form.get("title")).toBe("Payments API");
    expect(form.get("format")).toBe("openapi");
    expect(form.get("dry_run")).toBe("false");
    expect(form.has("native_schema")).toBe(false);
  });

  it("--schema with --existing and --domain publishes to the Domain", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    await file(ctx, ".git/HEAD", "ref: refs/heads/main\n");
    await file(ctx, "payments.yaml", SPEC);
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--domain",
      "DOM-pay",
      "--schema",
      "payments.yaml",
      "--existing",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/domains/DOM-pay/contracts/publish`,
    });
  });

  it("--schema without --existing proposes the file as a new contract with its title", async () => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    await file(ctx, "payments.yaml", SPEC);
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--project",
      "ALPHA",
      "--title",
      "Payments API",
      "--schema",
      "payments.yaml",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(PROPOSED);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/projects/ALPHA/contracts/proposals`,
    });
    const form = calls[0]!.form!;
    expect(await (form.get("file") as File).text()).toBe(SPEC);
    expect(form.get("title")).toBe("Payments API");
    expect(form.get("dry_run")).toBe("false");
    expect(form.has("format")).toBe(false);
  });

  it("--schema without --existing sends the files beside it and --schema-format as format", async () => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--project",
      "ALPHA",
      "--title",
      "Payments API",
      "--schema-format",
      "openapi",
      "--schema",
      entry,
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const form = calls[0]!.form!;
    expect((await parts(form, "files")).map(([name]) => name)).toEqual([
      "common.yml",
      "schemas/payment.json",
      "schemas/refund.yaml",
    ]);
    expect(form.get("format")).toBe("openapi");
  });

  it.each([
    ["no --title", ["--project", "ALPHA", "--schema", "payments.yaml"]],
    [
      "--domain without --existing",
      ["--domain", "DOM-pay", "--title", "P", "--schema", "payments.yaml"],
    ],
    [
      "-f",
      ["--project", "ALPHA", "--title", "P", "--schema", "payments.yaml", "-f", "contract.json"],
    ],
    [
      "--markdown",
      ["--project", "ALPHA", "--title", "P", "--schema", "payments.yaml", "--markdown", "doc.md"],
    ],
    [
      "--owner",
      ["--project", "ALPHA", "--title", "P", "--schema", "payments.yaml", "--owner", USER_ID],
    ],
    [
      "--kind",
      ["--project", "ALPHA", "--title", "P", "--schema", "payments.yaml", "--kind", "rest"],
    ],
    [
      "a prose --schema-format",
      [
        "--project",
        "ALPHA",
        "--title",
        "P",
        "--schema",
        "payments.yaml",
        "--schema-format",
        "prose",
        "--existing",
      ],
    ],
  ])("--schema with %s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    await file(ctx, ".git/HEAD", "ref: refs/heads/main\n");
    await file(ctx, "payments.yaml", SPEC);
    await file(ctx, "contract.json", BODY);
    await file(ctx, "doc.md", "# Payments\n");
    const { code, body } = await run(ctx, "contract", "create", ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });

  it("--existing sets describes_existing, and the flags override the file", async () => {
    const { ctx, calls } = await setup({ respond: created });
    const name = await file(ctx, "contract.json", { ...BODY, describes_existing: false });
    await file(ctx, "doc.md", "# Payments\n\nThe text.\n");
    const { code, body } = await run(
      ctx,
      "contract",
      "create",
      "--project",
      "ALPHA",
      "-f",
      name,
      "--title",
      "Payments",
      "--kind",
      "library",
      "--schema-format",
      "openapi",
      "--markdown",
      "doc.md",
      "--owner",
      USER_ID,
      "--existing",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      ...BODY,
      title: "Payments",
      kind: "library",
      schema_format: "openapi",
      markdown: "# Payments\n\nThe text.\n",
      owner_user_id: USER_ID,
      describes_existing: true,
    });
  });

  it.each([
    ["no title", { ...BODY, title: undefined }, "$.title"],
    ["an empty title", { ...BODY, title: "" }, "$.title"],
    ["a title over 200 characters", { ...BODY, title: "x".repeat(201) }, "$.title"],
    ["no kind", { ...BODY, kind: undefined }, "$.kind"],
    ["an unknown kind", { ...BODY, kind: "soap" }, "$.kind"],
    ["no markdown", { ...BODY, markdown: undefined }, "$.markdown"],
    ["no schema format", { ...BODY, schema_format: undefined }, "$.schema_format"],
    ["an unknown schema format", { ...BODY, schema_format: "wsdl" }, "$.schema_format"],
    ["a change", { ...BODY, change: "additive" }, "$"],
    [
      "an operation as a bare string",
      { ...BODY, operations: ["GET /payments"] },
      "$.operations[0]",
    ],
    ["an owner that is not a user id", { ...BODY, owner_user_id: "someone" }, "$.owner_user_id"],
    [
      "a describes_existing that is not a boolean",
      { ...BODY, describes_existing: "yes" },
      "$.describes_existing",
    ],
    [
      "a native schema over 1000000 characters",
      { ...BODY, native_schema: "x".repeat(1_000_001) },
      "$.native_schema",
    ],
  ])(
    "a body with %s is INPUT_INVALID (exit 2) and sends nothing",
    async (_name, contract, path) => {
      const { ctx, calls } = await setup({ respond: created });
      const name = await file(ctx, "contract.json", contract);
      const { code, body } = await run(ctx, "contract", "create", "--project", "ALPHA", "-f", name);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error).toMatchObject({ code: "INPUT_INVALID" });
      expect(body.error?.details["issues"]).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ["both flags", ["--project", "ALPHA", "--domain", "PAY", "-f", "contract.json"]],
    ["neither flag", ["-f", "contract.json"]],
    ["an empty --project", ["--project", " ", "-f", "contract.json"]],
    ["an extra argument", ["--project", "ALPHA", "CT-7", "-f", "contract.json"]],
    ["a missing -f file", ["--project", "ALPHA", "-f", "missing.json"]],
    ["a -f file that does not parse", ["--project", "ALPHA", "-f", "broken.json"]],
    ["a -f file that is not an object", ["--project", "ALPHA", "-f", "list.json"]],
    [
      "a missing --schema file",
      ["--project", "ALPHA", "-f", "contract.json", "--schema", "missing.yaml"],
    ],
    [
      "an empty --schema file",
      ["--project", "ALPHA", "-f", "contract.json", "--schema", "empty.md"],
    ],
    [
      "a missing --markdown file",
      ["--project", "ALPHA", "-f", "contract.json", "--markdown", "missing.md"],
    ],
    [
      "an empty --markdown file",
      ["--project", "ALPHA", "-f", "contract.json", "--markdown", "empty.md"],
    ],
    [
      "an empty --schema-format",
      ["--project", "ALPHA", "-f", "contract.json", "--schema-format", " "],
    ],
    ["an unknown --kind", ["--project", "ALPHA", "-f", "contract.json", "--kind", "soap"]],
    [
      "an unknown --schema-format",
      ["--project", "ALPHA", "-f", "contract.json", "--schema-format", "wsdl"],
    ],
    ["nothing to create from", ["--project", "ALPHA"]],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup({ respond: created });
    await file(ctx, "contract.json", BODY);
    await file(ctx, "broken.json", "{ not json");
    await file(ctx, "list.json", [BODY]);
    await file(ctx, "empty.md", "");
    const { code, body } = await run(ctx, "contract", "create", ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(["CLI_USAGE", "INPUT_INVALID"]).toContain(body.error?.code);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [403, "FORBIDDEN", ExitCode.Auth],
    [403, "ENTITLEMENT_LIMIT_REACHED", ExitCode.Auth],
    [404, "PROJECT_NOT_FOUND", ExitCode.NotFound],
    [404, "DOMAIN_NOT_FOUND", ExitCode.NotFound],
    [422, "CONTRACT_TITLE_INVALID", ExitCode.Usage],
    [422, "INPUT_INVALID", ExitCode.Usage],
  ])("a %d %s exits %d with the server's code", async (status, refused, exit) => {
    const answer = errorExample(refused);
    expect(publishedIssues("PublicError", answer)).toEqual([]);
    const { ctx, calls } = await setup({ respond: () => refusal(status, answer) });
    const name = await file(ctx, "contract.json", BODY);
    const flag = refused === "DOMAIN_NOT_FOUND" ? "--domain" : "--project";
    const { code, body } = await run(ctx, "contract", "create", flag, "NOPE", "-f", name);
    expect(code).toBe(exit);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(body.error).toMatchObject({ code: refused, message: answer.error.message });
    expect(calls).toHaveLength(1);
  });

  it.each([[{ number: 1 }], [{ ...CREATED, revisions: [{ number: 1 }] }], [null]])(
    "a created contract that does not match the published document exits 1 with UNEXPECTED_RESPONSE",
    async (data) => {
      const { ctx } = await setup({ respond: () => ok(data, 201) });
      const name = await file(ctx, "contract.json", BODY);
      const { code, body } = await run(ctx, "contract", "create", "--project", "ALPHA", "-f", name);
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error).toMatchObject({
        code: "UNEXPECTED_RESPONSE",
        details: { route: "POST /api/v1/projects/{project_ref}/contracts" },
      });
    },
  );

  it("the created fixture and the body match the published schemas", () => {
    expect(publishedIssues("ContractDetail", CREATED)).toEqual([]);
    expect(publishedIssues("ContractCreateRequest", BODY)).toEqual([]);
  });
});

describe("pidgen contract publish", () => {
  it("--project sends the entry and every .json, .yaml and .yml file under its directory as multipart, source_path relative to the repository root", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    const entry = await repository(ctx);
    const { code, body } = await run(ctx, "contract", "publish", entry, "--project", "ALPHA");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: PUBLISHED_CREATED, error: null, meta: META });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/projects/ALPHA/contracts/publish`,
      body: undefined,
    });
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    const form = calls[0]!.form!;
    expect(await parts(form, "file")).toEqual([["openapi.yaml", SPEC_TEXT]]);
    // The rest of the bundle, each named by its path relative to the entry's directory.
    expect(await parts(form, "files")).toEqual([
      ["common.yml", "components: {}\n"],
      ["schemas/payment.json", '{"type":"object"}'],
      ["schemas/refund.yaml", "type: object\n"],
    ]);
    expect(form.get("source_path")).toBe("contracts/payments/openapi.yaml");
    expect(form.get("source_kind")).toBe("upload");
    expect(form.get("dry_run")).toBe("false");
    expect(form.get("breaking")).toBe("false");
    for (const absent of ["commit", "ref", "format", "title"]) expect(form.has(absent)).toBe(false);
  });

  it("under CI=true sends source_kind ci, with --commit, --ref and --path", async () => {
    const { ctx, calls } = await setup({
      respond: published(PUBLISHED_REVISED),
      env: { CI: "true" },
    });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "ALPHA",
      "--commit",
      "9c01d2e",
      "--ref",
      "refs/heads/main",
      "--path",
      "api/payments.yaml",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(PUBLISHED_REVISED);
    const form = calls[0]!.form!;
    expect(form.get("source_kind")).toBe("ci");
    expect(form.get("commit")).toBe("9c01d2e");
    expect(form.get("ref")).toBe("refs/heads/main");
    expect(form.get("source_path")).toBe("api/payments.yaml");
  });

  it("CI set to anything but true sends source_kind upload", async () => {
    const { ctx, calls } = await setup({
      respond: published(PUBLISHED_CREATED),
      env: { CI: "false" },
    });
    const entry = await repository(ctx);
    const { code } = await run(ctx, "contract", "publish", entry, "--project", "ALPHA");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]!.form!.get("source_kind")).toBe("upload");
  });

  it("--domain sends POST /domains/{domain_id}/contracts/publish", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    const entry = await repository(ctx);
    const { code } = await run(ctx, "contract", "publish", entry, "--domain", "DOM-pay");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/domains/DOM-pay/contracts/publish`,
    });
  });

  it("--include sends only the files beside the entry that match its globs", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "ALPHA",
      "--include",
      "schemas/*.json",
      "--include",
      "*.yml",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const names = (await parts(calls[0]!.form!, "files")).map(([name]) => name);
    expect(names).toEqual(["common.yml", "schemas/payment.json"]);
  });

  it("--check sends dry_run and exits 0 on an additive change", async () => {
    const { ctx, calls } = await setup({ respond: published(DRY_RUN_ADDITIVE) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "ALPHA",
      "--check",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(DRY_RUN_ADDITIVE);
    expect(calls[0]!.form!.get("dry_run")).toBe("true");
  });

  it("--check exits 0 when the file is unchanged", async () => {
    const { ctx } = await setup({ respond: published({ ...PUBLISHED_UNCHANGED, dry_run: true }) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "ALPHA",
      "--check",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ outcome: "unchanged" });
  });

  it("--check on a breaking change exits 5 with CONTRACT_CHANGE_BREAKING, naming why", async () => {
    const { ctx, calls } = await setup({ respond: published(DRY_RUN_BREAKING) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "ALPHA",
      "--check",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(body.error?.code).toBe("CONTRACT_CHANGE_BREAKING");
    expect(body.error?.message).toContain(DRY_RUN_BREAKING.change_reason);
    expect(body.error?.details).toMatchObject({ result: DRY_RUN_BREAKING });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.form!.get("dry_run")).toBe("true");
  });

  it("--check on a breaking change with no reason names the removed operations", async () => {
    const { ctx } = await setup({
      respond: published({ ...DRY_RUN_BREAKING, change_reason: "" }),
    });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "A",
      "--check",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("CONTRACT_CHANGE_BREAKING");
    expect(body.error?.message).toContain("Removes DELETE /payments/{id}.");
  });

  it("--check --breaking accepts a breaking change: sends breaking and exits 0", async () => {
    const breaking = DRY_RUN_BREAKING;
    const { ctx, calls } = await setup({ respond: published(breaking) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      entry,
      "--project",
      "ALPHA",
      "--check",
      "--breaking",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(breaking);
    expect(calls[0]!.form!.get("dry_run")).toBe("true");
    expect(calls[0]!.form!.get("breaking")).toBe("true");
  });

  it.each([
    [422, "CONTRACT_FILE_INVALID"],
    [422, "CONTRACT_FORMAT_UNSUPPORTED"],
    [422, "CONTRACT_EXTERNAL_REF"],
    [422, "CONTRACT_CONVERSION_TIMEOUT"],
    [413, "FILE_TOO_LARGE"],
  ])("a %d %s prints every error with its location and exits 5", async (status, refused) => {
    const answer = fileRefusal(refused);
    expect(publishedIssues("PublicError", answer)).toEqual([]);
    const { ctx, calls } = await setup({ respond: () => refusal(status, answer) });
    const entry = await repository(ctx);
    const { code, body } = await run(ctx, "contract", "publish", entry, "--project", "ALPHA");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(body.error?.code).toBe(refused);
    expect(body.error?.details).toMatchObject({
      errors: answer.error.details.errors,
      refusal_id: "CPR-example-1",
      source_path: "contracts/payments/openapi.yaml",
      server_message: answer.error.message,
    });
    for (const { message, location } of answer.error.details.errors) {
      expect(body.error?.message).toContain(`${location ?? "(no location)"}: ${message}`);
    }
    expect(body.error?.message).toContain("3 errors");
    expect(calls).toHaveLength(1);
  });

  it.each([
    [403, "FORBIDDEN", ExitCode.Auth],
    [404, "PROJECT_NOT_FOUND", ExitCode.NotFound],
  ])("a %d %s exits %d with the server's code", async (status, refused, exit) => {
    const answer = errorExample(refused);
    const { ctx } = await setup({ respond: () => refusal(status, answer) });
    const entry = await repository(ctx);
    const { code, body } = await run(ctx, "contract", "publish", entry, "--project", "NOPE");
    expect(code).toBe(exit);
    expect(body.error).toMatchObject({ code: refused, message: answer.error.message });
  });

  it.each([[{ status: "published" }], [{ ...PUBLISHED_CREATED, added: "GET /payments" }], [null]])(
    "an answer that does not match the fragment exits 1 with UNEXPECTED_RESPONSE",
    async (data) => {
      const { ctx } = await setup({ respond: published(data) });
      const entry = await repository(ctx);
      const { code, body } = await run(ctx, "contract", "publish", entry, "--project", "ALPHA");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body.error).toMatchObject({
        code: "UNEXPECTED_RESPONSE",
        details: { route: "POST /api/v1/projects/{project_ref}/contracts/publish" },
      });
    },
  );

  it.each([
    ["no file", ["--project", "ALPHA"]],
    ["a missing file", ["repo/missing.yaml", "--project", "ALPHA"]],
    ["a directory", ["repo/contracts", "--project", "ALPHA"]],
    ["both --project and --domain", ["ENTRY", "--project", "ALPHA", "--domain", "DOM-pay"]],
    ["neither --project nor --domain", ["ENTRY"]],
    ["an empty --path", ["ENTRY", "--project", "ALPHA", "--path", " "]],
    ["an absolute --path", ["ENTRY", "--project", "ALPHA", "--path", "/etc/openapi.yaml"]],
    ["a --path that leaves the repository", ["ENTRY", "--project", "ALPHA", "--path", "../x.yaml"]],
    ["an extra argument", ["ENTRY", "extra.yaml", "--project", "ALPHA"]],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    const entry = await repository(ctx);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      ...argv.map((arg) => (arg === "ENTRY" ? entry : arg)),
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });

  it("outside a repository without --path is a usage error that asks for --path", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    await file(ctx, "loose/openapi.yaml", SPEC_TEXT);
    const { code, body } = await run(
      ctx,
      "contract",
      "publish",
      "loose/openapi.yaml",
      "--project",
      "ALPHA",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.message).toContain("--path");
    expect(calls).toHaveLength(0);
  });

  it("a bundle over 200 files is FILE_TOO_LARGE (exit 5) and sends nothing", async () => {
    const { ctx, calls } = await setup({ respond: published(PUBLISHED_CREATED) });
    const entry = await repository(ctx);
    for (let n = 0; n < 200; n++) await file(ctx, `repo/contracts/payments/many/${n}.json`, {});
    const { code, body } = await run(ctx, "contract", "publish", entry, "--project", "ALPHA");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen contract propose", () => {
  it("sends the files beside the fragment, named by their paths relative to it, so its $refs resolve", async () => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    const entry = await repository(ctx);
    const { code, body } = await run(ctx, "contract", "propose", "CT-12", entry);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const form = calls[0]!.form!;
    expect(await parts(form, "file")).toEqual([["openapi.yaml", SPEC_TEXT]]);
    expect(await parts(form, "files")).toEqual([
      ["common.yml", "components: {}\n"],
      ["schemas/payment.json", JSON.stringify({ type: "object" })],
      ["schemas/refund.yaml", "type: object\n"],
    ]);
  });

  it("--include sends only the files beside the fragment that match its globs", async () => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    const entry = await repository(ctx);
    const argv = [
      "--project",
      "ALPHA",
      "--title",
      "Payments",
      entry,
      "--include",
      "schemas/*.json",
    ];
    const { code, body } = await run(ctx, "contract", "propose", ...argv);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls[0]!.url).toBe(`${SERVER}/api/v1/projects/ALPHA/contracts/proposals`);
    const names = (await parts(calls[0]!.form!, "files")).map(([name]) => name);
    expect(names).toEqual(["schemas/payment.json"]);
  });

  it("over 200 files beside the fragment exits 5 with FILE_TOO_LARGE and sends nothing", async () => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    await file(ctx, "big/fragment.yaml", SPEC_TEXT);
    for (let i = 0; i < 200; i++) await file(ctx, `big/schemas/s${i}.json`, {});
    const { code, body } = await run(ctx, "contract", "propose", "CT-12", "big/fragment.yaml");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(calls).toHaveLength(0);
  });

  it("<contract> <fragment> sends POST /contracts/{contract_id}/proposals and prints which operations became pending and which were already landed", async () => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    await file(ctx, "refund.yaml", SPEC_TEXT);
    const { code, body } = await run(ctx, "contract", "propose", "CT-12", "refund.yaml");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toEqual({ ok: true, data: PROPOSED, error: null, meta: META });
    expect(body.data).toMatchObject({
      pending: ["POST /payments/{id}/refund"],
      landed: ["GET /payments"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/contracts/CT-12/proposals`,
      body: undefined,
    });
    const form = calls[0]!.form!;
    expect(await parts(form, "file")).toEqual([["refund.yaml", SPEC_TEXT]]);
    expect(form.get("dry_run")).toBe("false");
    expect(form.has("title")).toBe(false);
  });

  it("--project --title <fragment> proposes a new contract with its title", async () => {
    const { ctx, calls } = await setup({ respond: published({ ...PROPOSED, landed: [] }) });
    await file(ctx, "payments.yaml", SPEC_TEXT);
    const { code, body } = await run(
      ctx,
      "contract",
      "propose",
      "--project",
      "ALPHA",
      "--title",
      "Payments API",
      "payments.yaml",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SERVER}/api/v1/projects/ALPHA/contracts/proposals`,
    });
    expect(calls[0]!.form!.get("title")).toBe("Payments API");
  });

  it("--check sends dry_run", async () => {
    const dry = { ...PROPOSED, dry_run: true, acceptance: null };
    const { ctx, calls } = await setup({ respond: published(dry) });
    await file(ctx, "refund.yaml", SPEC_TEXT);
    const { code, body } = await run(ctx, "contract", "propose", "CT-12", "refund.yaml", "--check");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body.data).toEqual(dry);
    expect(calls[0]!.form!.get("dry_run")).toBe("true");
  });

  it("a refused fragment prints every error with its location and exits 5", async () => {
    const answer = fileRefusal("CONTRACT_FILE_INVALID", null);
    const { ctx } = await setup({ respond: () => refusal(422, answer) });
    await file(ctx, "refund.yaml", SPEC_TEXT);
    const { code, body } = await run(ctx, "contract", "propose", "CT-12", "refund.yaml");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("CONTRACT_FILE_INVALID");
    expect(body.error?.details).toMatchObject({ errors: answer.error.details.errors });
    for (const { message, location } of answer.error.details.errors) {
      expect(body.error?.message).toContain(`${location ?? "(no location)"}: ${message}`);
    }
  });

  it("an unknown contract exits 4 with CONTRACT_NOT_FOUND", async () => {
    const answer = errorExample("CONTRACT_NOT_FOUND");
    const { ctx } = await setup({ respond: () => refusal(404, answer) });
    await file(ctx, "refund.yaml", SPEC_TEXT);
    const { code, body } = await run(ctx, "contract", "propose", "CT-99", "refund.yaml");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({ code: "CONTRACT_NOT_FOUND" });
  });

  it("an answer that does not match the fragment exits 1 with UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup({ respond: published({ ...PROPOSED, pending: "x" }) });
    await file(ctx, "refund.yaml", SPEC_TEXT);
    const { code, body } = await run(ctx, "contract", "propose", "CT-12", "refund.yaml");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      details: { route: "POST /api/v1/contracts/{contract_id}/proposals" },
    });
  });

  it.each([
    ["no arguments", []],
    ["a contract and no fragment", ["CT-12"]],
    ["a missing fragment", ["CT-12", "missing.yaml"]],
    ["--project without --title", ["--project", "ALPHA", "refund.yaml"]],
    ["--title without --project", ["CT-12", "refund.yaml", "--title", "P"]],
    ["--project with a contract", ["--project", "ALPHA", "--title", "P", "CT-12", "refund.yaml"]],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup({ respond: published(PROPOSED) });
    await file(ctx, "refund.yaml", SPEC_TEXT);
    const { code, body } = await run(ctx, "contract", "propose", ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("the publishing fixtures are the published shapes", () => {
  it("each publish and proposal answer matches the published document", () => {
    for (const result of [
      PUBLISHED_CREATED,
      PUBLISHED_REVISED,
      PUBLISHED_UNCHANGED,
      DRY_RUN_BREAKING,
      DRY_RUN_ADDITIVE,
    ]) {
      expect(publishedIssues("ContractPublishResult", result)).toEqual([]);
    }
    expect(publishedIssues("ContractProposalResult", PROPOSED)).toEqual([]);
  });

  it("the document states the publish and proposal fields the commands send and the refusal codes", () => {
    type Operation = {
      requestBody: { content: Record<string, { schema: { $ref: string } }> };
      responses: Record<string, { description: string }>;
    };
    const paths = publishedDocument.paths as unknown as Record<string, Record<string, Operation>>;
    const schemas = publishedDocument.components.schemas as unknown as Record<
      string,
      { properties: Record<string, { enum?: string[] }> }
    >;
    const fields = (path: string) => {
      const ref = paths[path]!["post"]!.requestBody.content["multipart/form-data"]!.schema.$ref;
      return Object.keys(schemas[ref.split("/").pop()!]!.properties).sort();
    };
    for (const path of [
      "/api/v1/projects/{project_ref}/contracts/publish",
      "/api/v1/domains/{domain_id}/contracts/publish",
    ]) {
      expect(fields(path)).toEqual(
        [
          "breaking",
          "commit",
          "dry_run",
          "file",
          "files",
          "format",
          "ref",
          "source_kind",
          "source_path",
          "title",
        ].sort(),
      );
      const refused = paths[path]!["post"]!.responses;
      for (const code of Object.keys(FILE_REFUSALS)) {
        expect(`${refused["413"]!.description} ${refused["422"]!.description}`).toContain(code);
      }
    }
    expect(fields("/api/v1/contracts/{contract_id}/proposals")).toEqual(
      expect.arrayContaining(["dry_run", "file"]),
    );
    expect(fields("/api/v1/projects/{project_ref}/contracts/proposals")).toEqual(
      expect.arrayContaining(["dry_run", "file", "title"]),
    );
    expect(schemas["ContractPublishResult"]!.properties["outcome"]!.enum).toEqual([
      "created",
      "revised",
      "unchanged",
    ]);
    expect(schemas["ContractOperationState"]!.properties["state"]!.enum).toEqual([
      "landed",
      "pending",
      "removed",
    ]);
  });
});

describe("the fixtures are the published shapes", () => {
  it("each contract fixture matches its published schema", () => {
    expect(publishedIssues("ProjectContractsResource", PROJECT_LIST)).toEqual([]);
    expect(publishedIssues("DomainContractsResource", DOMAIN_LIST)).toEqual([]);
    for (const contract of [CONTRACT, REVISED, ACCEPTED]) {
      expect(publishedIssues("ContractDetail", contract)).toEqual([]);
    }
    expect(publishedIssues("PublicError", errorExample("CONTRACT_NOT_FOUND"))).toEqual([]);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])(
  "resource presentation: contract project list at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["contract", "list", "--project", "ALPHA"];
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
      "Contracts",
      "Provides (1 displayed)",
      "Builds against (1 displayed)",
      "CT-7",
      "Payments API",
      "accepted",
      "ALPHA",
    ])
      expect(output).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
    expect(json.ok).toBe(true);
  },
);

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])(
  "resource presentation: contract domain list at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["contract", "list", "--domain", "PAY"];
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
      "Contracts",
      "Own (1 displayed)",
      "Coverage (2 displayed)",
      "ALPHA",
      "BETA",
      "CT-12",
    ])
      expect(output).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
    expect(json.ok).toBe(true);
  },
);

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: contract show at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["contract", "show", "CT-7"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Contract", "Revisions", "Markdown", "Native schema", "Payments API"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

it.each([40, 80, 120])(
  "contract dry runs keep change findings without recording at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({ respond: published(DRY_RUN_ADDITIVE) });
    ctx.io.stdoutColumns = columns;
    await file(ctx, ".git/HEAD", "ref: refs/heads/main\n");
    await file(ctx, "payments.yaml", SPEC_TEXT);
    const json = await expectMutationParity(
      ctx,
      calls,
      ["contract", "publish", "payments.yaml", "--project", "PAY", "--check"],
      ["Preview — not applied.", "Dry run: true", "Added", "Removed"],
      ExitCode.Ok,
      async (call) => ({
        ...call,
        form: await Promise.all(
          [...call.form!.entries()].map(async ([name, value]) => [
            name,
            typeof value === "string"
              ? value
              : { name: value.name, type: value.type, text: await value.text() },
          ]),
        ),
      }),
    );
    expect(json.data).toEqual(DRY_RUN_ADDITIVE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.form!.get("dry_run")).toBe("true");
  },
);
