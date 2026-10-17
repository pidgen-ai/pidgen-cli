import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { apiCommands } from "../../src/commands/api/call.js";
import { findPublicOperation, PUBLIC_API_DOCUMENT } from "../../src/commands/api/document.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import type { RunContext } from "../../src/core/context.js";
import { CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import type { OpenApiDocument } from "../../src/core/input.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

// Run the CLI with the `api` commands bound to the contract-test fixture document instead of the
// bundled contracts/openapi.json, through the factory's injection point.
vi.mock("../../src/commands/index.js", async () => {
  const { readFileSync: read } = await import("node:fs");
  const { apiCommands: build } = await import("../../src/commands/api/call.js");
  const fixture = JSON.parse(
    read(new URL("../fixtures/openapi.fixture.json", import.meta.url), "utf8"),
  ) as OpenApiDocument;
  return { commands: build(fixture) };
});

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/openapi.fixture.json", import.meta.url), "utf8"),
) as OpenApiDocument;

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const APPLY_BODY = { preview_digest: "sha256:abc", idempotency_key: "k-1", acknowledgements: [] };

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
  body: string | undefined;
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

async function setup(
  options: {
    respond?: (call: Call) => Response;
    config?: Config | null;
    overrides?: Partial<RunContext>;
  } = {},
) {
  const calls: Call[] = [];
  const respond =
    options.respond ?? (() => jsonResponse(200, { status: "ok", data: { answer: 42 } }));
  const ctx = await testContext({
    fetch: (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
    ...options.overrides,
  });
  const config = options.config === undefined ? CONFIG : options.config;
  if (config) await saveConfig(ctx, config);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function writeBody(ctx: TestContext, name: string, content: string): Promise<string> {
  const path = join(ctx.cwd, name);
  await writeFile(path, content);
  return path;
}

function thrown(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected a CliError");
}

describe("pidgen api: paths not public", () => {
  it("refuses a path not public with PATH_NOT_PUBLIC, exit 2, and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/tickets/PIDGEN-12");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "PATH_NOT_PUBLIC", details: { method: "GET", path: "/tickets/PIDGEN-12" } },
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a method not public on a documented path, naming the allowed methods", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "api", "delete", "/projects/proj-example");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({
      code: "PATH_NOT_PUBLIC",
      details: { method: "DELETE", allowed_methods: ["GET"] },
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a path not public before reading a -f body or the configuration", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "api", "post", "/admin/users", "-f", "missing.json");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("PATH_NOT_PUBLIC");
    expect(calls).toHaveLength(0);
  });

  it.each([
    "/projects/..",
    "/projects/%2e%2e",
    "/projects/.",
    "/projects/a%2Fb",
    "/projects/a%5Cb",
    "/projects/a\\b",
    "/projects/%zz",
    "/api/v1/projects/proj-example/..",
  ])("refuses %s as not public (dot segments and encoded separators)", async (path) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "api", "get", path);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("PATH_NOT_PUBLIC");
    expect(calls).toHaveLength(0);
  });

  it("checks paths against the bundled contracts/openapi.json document", async () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../contracts/openapi.json", import.meta.url), "utf8"),
    ) as OpenApiDocument;
    expect(PUBLIC_API_DOCUMENT).toEqual(committed);
    expect(findPublicOperation(PUBLIC_API_DOCUMENT, "get", "/tickets/PIDGEN-12").template).toBe(
      "/api/v1/tickets/{ticket_id}",
    );

    const { ctx, calls } = await setup();
    const commands = apiCommands();
    const global = { format: "json" as const, timeoutSeconds: 120 };
    const get = commands.find((spec) => spec.path[1] === "get");
    const published = await get?.run(ctx, { args: ["/projects"], options: { query: [] }, global });
    expect(published).toMatchObject({ data: { answer: 42 } });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${SERVER}/api/v1/projects`,
    ]);

    const notPublic = await get
      ?.run(ctx, { args: ["/admin/users"], options: { query: [] }, global })
      .catch((reason: unknown) => reason);
    expect(notPublic).toMatchObject({ code: "PATH_NOT_PUBLIC", exitCode: ExitCode.Usage });
    const del = commands.find((spec) => spec.path[1] === "delete");
    const wrongMethod = await del
      ?.run(ctx, { args: ["/projects"], options: { query: [] }, global })
      .catch((reason: unknown) => reason);
    expect(wrongMethod).toMatchObject({ code: "PATH_NOT_PUBLIC", exitCode: ExitCode.Usage });
    expect(calls).toHaveLength(1);
  });

  it("registers get, post, put, patch and delete under api with the bundled document", async () => {
    const actual = await vi.importActual<typeof import("../../src/commands/index.js")>(
      "../../src/commands/index.js",
    );
    const verbs = actual.commands.filter((spec) => spec.path[0] === "api").map((s) => s.path[1]);
    expect(verbs).toEqual(["get", "post", "put", "patch", "delete"]);
  });
});

describe("pidgen api: path template matching", () => {
  it("matches the template /projects/{project_id} without the /api/v1 prefix", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "api", "get", "/projects/proj-example");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${SERVER}/api/v1/projects/proj-example`],
    ]);
  });

  it("matches the template /projects/{project_id} with the /api/v1 prefix", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "api", "get", "/api/v1/projects/proj-example");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/api/v1/projects/proj-example`]);
  });

  it("matches a multi-parameter template such as /tickets/{ticket_id}/retry/preview", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "api", "post", "tickets/PIDGEN-4/retry/preview");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", `${SERVER}/api/v1/tickets/PIDGEN-4/retry/preview`],
    ]);
  });

  it("template parameters match one non-empty segment only", () => {
    for (const path of ["/projects/", "/projects/a/b", "/projects//"]) {
      expect(thrown(() => findPublicOperation(FIXTURE, "get", path)).code).toBe("PATH_NOT_PUBLIC");
    }
  });

  it("template matching prefers the template with the most literal segments", () => {
    const document: OpenApiDocument = {
      paths: {
        "/tickets/{ref}": { get: { operationId: "showTicket" } },
        "/api/v1/tickets/template": { get: { operationId: "ticketTemplate" } },
        "/tickets/{ref}/deps": { get: {}, post: {} },
        "/files/{name}.json": { get: {} },
      },
    };
    expect(findPublicOperation(document, "get", "/tickets/template")).toMatchObject({
      template: "/api/v1/tickets/template",
      path: "/api/v1/tickets/template",
    });
    expect(findPublicOperation(document, "GET", "/api/v1/tickets/PIDGEN-12")).toMatchObject({
      template: "/tickets/{ref}",
      path: "/api/v1/tickets/PIDGEN-12",
      operation: { operationId: "showTicket" },
    });
    expect(findPublicOperation(document, "post", "/tickets/PIDGEN-12/deps").template).toBe(
      "/tickets/{ref}/deps",
    );
    expect(findPublicOperation(document, "get", "/files/report.json").template).toBe(
      "/files/{name}.json",
    );
    expect(thrown(() => findPublicOperation(document, "get", "/files/report.yaml")).code).toBe(
      "PATH_NOT_PUBLIC",
    );
  });

  it("template paths refuse an embedded query string with CLI_USAGE", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/projects?limit=5");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen api: request bodies", () => {
  it("sends a valid -f body as JSON after validating it", async () => {
    const { ctx, calls } = await setup({
      respond: () => jsonResponse(202, { status: "ok", data: { request_id: "req-1" } }),
    });
    const file = await writeBody(
      ctx,
      "apply.yaml",
      "preview_digest: sha256:abc\nidempotency_key: k-1\nacknowledgements: []\n",
    );
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ request_id: "req-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(APPLY_BODY);
  });

  it("reads a -f - body from standard input", async () => {
    const { ctx, calls } = await setup({
      overrides: { readStdin: () => Promise.resolve(JSON.stringify(APPLY_BODY)) },
    });
    const { code } = await run(ctx, "api", "post", "/tickets/PIDGEN-4/retry/apply", "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(APPLY_BODY);
  });

  it("refuses an invalid body that does not match the schema before any request is sent", async () => {
    const { ctx, calls } = await setup();
    const file = await writeBody(ctx, "apply.json", JSON.stringify({ preview_digest: 7 }));
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.preview_digest", "$.idempotency_key", "$.acknowledgements"]),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid body with a syntax error before any request is sent", async () => {
    const { ctx, calls } = await setup();
    const file = await writeBody(ctx, "apply.json", '{"preview_digest": "x",\n  oops}');
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "INPUT_INVALID", details: { line: 2 } });
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid body from a missing file or empty standard input", async () => {
    const { ctx, calls } = await setup({ overrides: { readStdin: () => Promise.resolve("  ") } });
    const missing = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "-f",
      "nope.json",
    );
    expect(missing.code).toBe(ExitCode.Usage);
    expect(missing.body.error?.code).toBe("INPUT_INVALID");
    const empty = await run(ctx, "api", "post", "/tickets/PIDGEN-4/retry/apply", "-f", "-");
    expect(empty.code).toBe(ExitCode.Usage);
    expect(empty.body.error?.code).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid body for an operation that takes none", async () => {
    const { ctx, calls } = await setup();
    const file = await writeBody(ctx, "body.json", "{}");
    const { code, body } = await run(ctx, "api", "get", "/projects", "-f", file);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid body: a required body that is missing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "api", "post", "/tickets/PIDGEN-4/retry/apply");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    expect(body.error?.message).toContain("-f");
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen api: server responses", () => {
  it("passes through server data and meta into the envelope", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        jsonResponse(
          200,
          { status: "ok", data: { items: [{ project_id: "proj-example" }], next_cursor: null } },
          { "x-request-id": "req-abc", "pidgen-api-version": "1.0" },
        ),
    });
    const { code, body } = await run(ctx, "api", "get", "/projects", "--query", "limit=5");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { items: [{ project_id: "proj-example" }], next_cursor: null },
      error: null,
      meta: {
        request_id: "req-abc",
        api_version: "1.0",
        profile: "default",
        account: "ACC-EXAMPLE",
        cli_version: "0.0.0-test",
      },
    });
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("passes through a body that is not wrapped in {status, data} unchanged", async () => {
    const { ctx } = await setup({ respond: () => jsonResponse(200, { anything: [1, 2] }) });
    const { code, body } = await run(ctx, "api", "get", "/requests/req-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ anything: [1, 2] });
  });

  it("passes through a server error code (404 PROJECT_NOT_FOUND, exit 4)", async () => {
    const { ctx } = await setup({
      respond: () =>
        jsonResponse(
          404,
          { detail: { code: "PROJECT_NOT_FOUND", message: "No project proj-missing." } },
          { "x-request-id": "req-404" },
        ),
    });
    const { code, body } = await run(ctx, "api", "get", "/projects/proj-missing");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "No project proj-missing.",
        details: { status: 404, request_id: "req-404" },
      },
    });
  });

  it("passes through a server refusal code (409 PREVIEW_STALE, exit 6)", async () => {
    const { ctx } = await setup({
      respond: () =>
        jsonResponse(409, {
          detail: { code: "PREVIEW_STALE", message: "Preview again.", current_digest: "sha256:d" },
        }),
    });
    const file = await writeBody(ctx, "apply.json", JSON.stringify(APPLY_BODY));
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error).toMatchObject({
      code: "PREVIEW_STALE",
      details: { status: 409, current_digest: "sha256:d" },
    });
  });

  it("reads the public error shape into the envelope (409 PREVIEW_STALE, exit 6)", async () => {
    const { ctx } = await setup({
      respond: () =>
        jsonResponse(409, {
          status: "error",
          error: {
            code: "PREVIEW_STALE",
            message: "Preview again.",
            details: { current_digest: "sha256:d" },
            request_id: "req-409",
          },
        }),
    });
    const file = await writeBody(ctx, "apply.json", JSON.stringify(APPLY_BODY));
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/retry/apply",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "PREVIEW_STALE",
        message: "Preview again.",
        details: { status: 409, request_id: "req-409", current_digest: "sha256:d" },
      },
    });
  });

  it("sends --query parameters, keeping values with = in them", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(
      ctx,
      "api",
      "get",
      "/projects",
      "--query",
      "limit=5",
      "--query",
      "cursor=a=b",
    );
    expect(code).toBe(ExitCode.Ok);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/projects");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "5", cursor: "a=b" });
  });

  it("usage: a malformed or repeated --query exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const malformed = await run(ctx, "api", "get", "/projects", "--query", "limit");
    expect(malformed.code).toBe(ExitCode.Usage);
    expect(malformed.body.error?.code).toBe("CLI_USAGE");
    const repeated = await run(ctx, "api", "get", "/projects", "--query", "a=1", "--query", "a=2");
    expect(repeated.code).toBe(ExitCode.Usage);
    expect(repeated.body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("usage: a missing path or an unknown method exits 2", async () => {
    const { ctx, calls } = await setup();
    const noPath = await run(ctx, "api", "get");
    expect(noPath.code).toBe(ExitCode.Usage);
    expect(noPath.body.error?.code).toBe("CLI_USAGE");
    const unknown = await run(ctx, "api", "head", "/projects");
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(calls).toHaveLength(0);
  });

  it("exits 3 with AUTH_REQUIRED when nothing is configured, sending nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "api", "get", "/projects");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(calls).toHaveLength(0);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: raw API at %s columns", async (columns) => {
  const { ctx, calls } = await setup({
    respond: () =>
      jsonResponse(200, {
        status: "ok",
        data: { text: "first line\n  second line", evidence: [{ path: "reports/output.md" }] },
      }),
  });
  ctx.io.stdoutColumns = columns;
  const argv = ["api", "get", "/projects"];
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
    "API response",
    "Text",
    "first line",
    "second line",
    "Evidence (1 displayed)",
    "reports/output.md",
  ])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// AC-2e443d6f3bc5 / AC-2e82c79f28be: HTTP acceptance is presentation context, never JSON data.
it.each([40, 80, 120])(
  "raw mutation acceptance at %s columns preserves the JSON and single request",
  async (columns) => {
    const handle = "/api/v1/operations/" + "a".repeat(80);
    const data = { operation_handle: handle, follow_up: `pidgen api get ${handle} --format json` };
    const { ctx, calls } = await setup({
      respond: () => jsonResponse(202, { status: "ok", data }),
    });
    ctx.io.stdoutColumns = columns;
    const file = await writeBody(ctx, "apply.json", JSON.stringify(APPLY_BODY));
    const argv = ["api", "post", "/tickets/PIDGEN-4/retry/apply", "-f", file];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    expect(envelope(ctx).data).toEqual(data);
    const priorCalls = [...calls];
    calls.length = 0;
    ctx.out.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    expect(ctx.out.join("")).toContain("Accepted — still pending.");
    expect(ctx.out.join("")).toContain(data.follow_up);
    expect(ctx.out.join("")).not.toMatch(/Applied — settled|Completed/);
    expect(calls).toEqual(priorCalls);
    expect(calls).toHaveLength(1);
    expect(ctx.err).toEqual([]);
  },
);
