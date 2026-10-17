import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { PAGE_SIZE } from "../../src/core/read.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

// An Epic is an epic-kind Ticket: every `--kind epic` ticket command and every `pidgen epic` alias
// calls only the ticket routes. The stub below answers nothing else, and every test checks that
// no request reached `/epics` or `POST /tickets/{ref}/epic`.

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

function epic(number: number, project = "proj-example-a", prefix = "ALPHA") {
  return {
    id: `TKT-example-${prefix}-${number}`,
    ticket_key: `${prefix}-${number}`,
    account_id: "ACC-EXAMPLE",
    project_id: project,
    kind: "epic",
    parent_ticket_id: null,
    title: `Epic ${number}`,
    objective: "Everything people need to sign in.",
    stage: "backlog",
    branch_mode: "project_base",
    feature_branch: null,
    target_date: null,
    merge_policy: null,
    version: 3,
  };
}

const EPICS = [epic(12), epic(13), epic(4, "proj-example-b", "BETA")];
const ALPHA_12 = EPICS[0] as ReturnType<typeof epic>;
const TASK = {
  ...epic(7),
  kind: "task",
  title: "Ticket 7",
  branch_mode: null,
  parent_ticket_id: "TKT-example-ALPHA-12",
};
const PREREQUISITES = {
  ticket_id: ALPHA_12.id,
  ticket_key: ALPHA_12.ticket_key,
  stage: "backlog",
  ready: true,
  readiness_blockers: [],
  blockers: [],
  blocking_prerequisites: [],
};
const CREATED = epic(14);

const NEW_EPIC = {
  title: "Sign-in",
  description: "Everything people need to sign in.",
  project_id: "ALPHA",
  branch_mode: "create_new",
  feature_branch: "epic/sign-in",
  target_date: "2026-12-01T00:00:00Z",
  merge_policy: "manual",
};

function ok(status: number, data: unknown, requestId = "req_fake_ok", meta: unknown = null) {
  return jsonResponse(
    status,
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

const TICKETS: Record<string, Record<string, unknown>> = {
  "ALPHA-12": ALPHA_12,
  "ALPHA-7": TASK,
};

/** Answers the ticket routes of the public API for the tickets above, and nothing else. */
function server(call: Call): Response {
  const path = call.url.pathname;
  if (path === "/api/v1/tickets" && call.method === "GET") {
    const kind = call.url.searchParams.get("kind");
    const project = call.url.searchParams.get("project_id");
    const all = [...EPICS, TASK];
    const rows = all
      .filter((row) => (kind === null ? row.kind !== "epic" : row.kind === kind))
      .filter((row) => project === null || row.project_id === project);
    return ok(200, rows, "req_fake_list", { page: 1, per_page: PAGE_SIZE });
  }
  if (path === "/api/v1/tickets" && call.method === "POST") {
    return ok(201, { ...CREATED, ...(call.body as object) }, "req_fake_create");
  }
  const match = /^\/api\/v1\/tickets\/([^/]+)(\/prerequisites)?$/.exec(path);
  const ticket = match ? TICKETS[decodeURIComponent(match[1] ?? "")] : undefined;
  if (ticket && match?.[2] && call.method === "GET") {
    return ok(200, PREREQUISITES, "req_fake_prerequisites");
  }
  if (ticket && call.method === "GET") return ok(200, ticket, "req_fake_show");
  if (ticket && call.method === "PATCH") {
    const { version, ...changes } = call.body as { version: number };
    if (version !== ticket["version"]) return publicError(409, "CONFLICT", "The ticket changed.");
    return ok(200, { ...ticket, ...changes, version: version + 1 }, "req_fake_edit");
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

async function setup(options: { respond?: (call: Call) => Response; config?: Config | null } = {}) {
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
  const config = options.config === undefined ? CONFIG : options.config;
  if (config) await saveConfig(ctx, config);
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

function routes(calls: Call[]): string[][] {
  return calls.map((call) => [call.method, `${call.url.pathname}${call.url.search}`]);
}

function expectAuthenticated(call: Call | undefined) {
  expect(call?.headers).toMatchObject({
    authorization: `Bearer ${TOKEN}`,
    "x-pidgen-account": "ACC-EXAMPLE",
  });
}

const LIST_PAGE = `page=1&per_page=${PAGE_SIZE}`;

describe("pidgen ticket list --kind / pidgen epic list", () => {
  it("ticket list --kind epic lists only Epics, sending kind=epic", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list", "--kind", "epic");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: EPICS,
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    expect(routes(calls)).toEqual([["GET", `/api/v1/tickets?kind=epic&${LIST_PAGE}`]]);
    expectAuthenticated(calls[0]);
  });

  it("ticket list without --kind sends no kind, and the server leaves Epics out", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual([TASK]);
    expect(calls[0]?.url.searchParams.has("kind")).toBe(false);
  });

  it("ticket list --kind task sends kind=task", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "ticket", "list", "--kind", "task");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.searchParams.get("kind")).toBe("task");
  });

  it("epic list is ticket list --kind epic: GET /tickets?kind=epic", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "epic", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: EPICS,
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    expect(routes(calls)).toEqual([["GET", `/api/v1/tickets?kind=epic&${LIST_PAGE}`]]);
    expectAuthenticated(calls[0]);
  });

  it("epic list --project keeps one project's Epics, sent as project_id", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "epic", "list", "--project", "proj-example-b");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, data: [EPICS[2]] });
    expect(routes(calls)).toEqual([
      ["GET", `/api/v1/tickets?project_id=proj-example-b&kind=epic&${LIST_PAGE}`],
    ]);
  });

  it("epic list refused by the server (403 FORBIDDEN) keeps the code and exits 3", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not read tickets."),
    });
    const { code, body } = await run(ctx, "epic", "list");
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

  it.each([
    ["an empty --project", ["epic", "list", "--project", " "]],
    ["an argument", ["epic", "list", "ALPHA"]],
    ["an unknown --kind", ["ticket", "list", "--kind", "saga"]],
    ["--kind without a value", ["ticket", "list", "--kind"]],
  ])("usage: list with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket show --kind / pidgen epic show", () => {
  it.each([
    ["ticket show --kind epic", ["ticket", "show", "ALPHA-12", "--kind", "epic"]],
    ["epic show", ["epic", "show", "ALPHA-12"]],
  ])("%s reads the Epic with GET /tickets/{ref} and its prerequisites", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { ...ALPHA_12, prerequisites: PREREQUISITES },
      error: null,
      meta: { ...META, request_id: "req_fake_show" },
    });
    expect(routes(calls)).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-12"],
      ["GET", "/api/v1/tickets/ALPHA-12/prerequisites"],
    ]);
    expectAuthenticated(calls[0]);
  });

  it.each([
    ["ticket show --kind epic", ["ticket", "show", "ALPHA-7", "--kind", "epic"]],
    ["epic show", ["epic", "show", "ALPHA-7"]],
  ])("%s of a ticket that is not an Epic exits 4 with TICKET_KIND_MISMATCH", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "TICKET_KIND_MISMATCH",
        details: { ticket: "ALPHA-7", kind: "task", expected_kind: "epic" },
      },
    });
    expect(routes(calls)).toEqual([["GET", "/api/v1/tickets/ALPHA-7"]]);
  });

  it("epic show: an unknown ticket is the server's TICKET_NOT_FOUND, exits 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "epic", "show", "ALPHA-99");
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
    ["no key", ["epic", "show"]],
    ["an empty key", ["epic", "show", " "]],
    ["a .. key", ["epic", "show", ".."]],
    ["two keys", ["epic", "show", "ALPHA-12", "ALPHA-13"]],
    ["an unknown --kind", ["ticket", "show", "ALPHA-12", "--kind", "saga"]],
  ])("usage: show with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket create --kind / pidgen epic create", () => {
  it.each([
    ["ticket create --kind epic", ["ticket", "create", "--kind", "epic", "-f"]],
    ["epic create", ["epic", "create", "-f"]],
  ])("%s sends POST /tickets with kind epic and the file's fields", async (_, argv) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", NEW_EPIC);
    const { code, body } = await run(ctx, ...argv, name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { ...CREATED, ...NEW_EPIC, kind: "epic" },
      error: null,
      meta: { ...META, request_id: "req_fake_create" },
    });
    expect(routes(calls)).toEqual([["POST", "/api/v1/tickets"]]);
    expect(calls[0]?.body).toEqual({ ...NEW_EPIC, kind: "epic" });
    expectAuthenticated(calls[0]);
  });

  it("ticket create --kind epic accepts a file that already says kind: epic", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", { ...NEW_EPIC, kind: "epic" });
    const { code } = await run(ctx, "ticket", "create", "--kind", "epic", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ ...NEW_EPIC, kind: "epic" });
  });

  it("ticket create without --kind sends the file as written", async () => {
    const { ctx, calls } = await setup();
    const member = { title: "Sign-in form", objective: "A form.", parent_ticket_id: "ALPHA-12" };
    const name = await file(ctx, "task.json", member);
    const { code } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual(member);
  });

  it("epic create reads YAML from standard input and sends the same body", async () => {
    const { ctx, calls } = await setup();
    ctx.readStdin = () =>
      Promise.resolve(
        [
          "title: Sign-in",
          "description: Everything people need to sign in.",
          "project_id: ALPHA",
          "branch_mode: create_new",
          "feature_branch: epic/sign-in",
          "target_date: 2026-12-01T00:00:00Z",
          "merge_policy: manual",
          "",
        ].join("\n"),
      );
    const { code } = await run(ctx, "epic", "create", "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ ...NEW_EPIC, kind: "epic" });
  });

  it("epic create refused by the server (404 PROJECT_NOT_FOUND) is not found, exits 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "PROJECT_NOT_FOUND", "No such Project in the Account."),
    });
    const name = await file(ctx, "epic.json", NEW_EPIC);
    const { code, body } = await run(ctx, "epic", "create", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "PROJECT_NOT_FOUND", details: { status: 404 } },
    });
  });

  it("epic create refused by the server (422 EPIC_FIELD_REFUSED) keeps the code and exits 2", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "EPIC_FIELD_REFUSED", "An Epic takes no team_member_id."),
    });
    const name = await file(ctx, "epic.json", { ...NEW_EPIC, team_member_id: "AGENT-EXAMPLE" });
    const { code, body } = await run(ctx, "epic", "create", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "EPIC_FIELD_REFUSED" } });
  });

  it.each([
    ["without title", { project_id: "ALPHA" }, "$.title"],
    ["with an unknown branch mode", { ...NEW_EPIC, branch_mode: "fork" }, "$.branch_mode"],
    ["with an unknown merge policy", { ...NEW_EPIC, merge_policy: "sometimes" }, "$.merge_policy"],
    [
      "with a retired epic field",
      { ...NEW_EPIC, priority_weight: 3 },
      '$: Unrecognized key: "priority_weight"',
    ],
    ["that is not an object", ["a", "list"], "$"],
  ])("epic create: an invalid body %s exits 2 before any request", async (_, value, path) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", value);
    const { code, body } = await run(ctx, "epic", "create", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { method: "POST", path: "/tickets" } },
    });
    const issues = body.error?.details["issues"] as { path: string; message: string }[];
    const found = issues.flatMap((issue) => [issue.path, `${issue.path}: ${issue.message}`]);
    expect(found).toContain(path);
    expect(calls).toHaveLength(0);
  });

  it("ticket create --kind epic with a file of another kind exits 2 before any request", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "epic.json", { ...NEW_EPIC, kind: "story" });
    const { code, body } = await run(ctx, "ticket", "create", "--kind", "epic", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { issues: [{ path: "$.kind" }] } },
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no -f", ["epic", "create"]],
    ["an argument", ["epic", "create", "ALPHA-12", "-f", "epic.json"]],
    ["an unknown --kind", ["ticket", "create", "--kind", "saga", "-f", "epic.json"]],
  ])("usage: create with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    await file(ctx, "epic.json", NEW_EPIC);
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("epic create with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const name = await file(ctx, "epic.json", NEW_EPIC);
    const { code, body } = await run(ctx, "epic", "create", "-f", name);
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket edit --kind / pidgen epic edit", () => {
  const CHANGES = { title: "Sign-in, revised", merge_policy: null };

  it.each([
    ["ticket edit --kind epic", ["ticket", "edit", "ALPHA-12", "--kind", "epic", "-f"]],
    ["epic edit", ["epic", "edit", "ALPHA-12", "-f"]],
  ])("%s reads the Epic's version and sends PATCH /tickets/{ref}", async (_, argv) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", CHANGES);
    const { code, body } = await run(ctx, ...argv, name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { ...ALPHA_12, ...CHANGES, version: 4, admission: null },
      error: null,
      meta: { ...META, request_id: "req_fake_edit" },
    });
    expect(routes(calls)).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-12"],
      ["PATCH", "/api/v1/tickets/ALPHA-12"],
    ]);
    expect(calls[1]?.body).toEqual({ version: 3, ...CHANGES });
    expectAuthenticated(calls[1]);
  });

  it("epic edit reads YAML and sends the same fields as a JSON file", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.yaml", "priority: 2\nmerge_policy: auto\n");
    const { code } = await run(ctx, "epic", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual({ version: 3, priority: 2, merge_policy: "auto" });
  });

  it.each([
    ["ticket edit --kind epic", ["ticket", "edit", "ALPHA-7", "--kind", "epic", "-f"]],
    ["epic edit", ["epic", "edit", "ALPHA-7", "-f"]],
  ])("%s of a ticket that is not an Epic exits 4 and sends no PATCH", async (_, argv) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", CHANGES);
    const { code, body } = await run(ctx, ...argv, name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_KIND_MISMATCH" } });
    expect(routes(calls)).toEqual([["GET", "/api/v1/tickets/ALPHA-7"]]);
  });

  it("epic edit of an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, "epic", "edit", "ALPHA-99", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "TICKET_NOT_FOUND", details: { status: 404, request_id: "req_fake_error" } },
    });
    expect(routes(calls)).toEqual([["GET", "/api/v1/tickets/ALPHA-99"]]);
  });

  it.each([
    ["with a priority out of range", { priority: 0 }, "$.priority"],
    ["with a retired epic field", { status: "completed" }, '$: Unrecognized key: "status"'],
    ["with an empty title", { title: "" }, "$.title"],
    ["that is not an object", "just text\n", "$"],
    ["with no field to change", {}, "$"],
  ])("epic edit: an invalid body %s exits 2 before any request", async (_, value, path) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.yaml", value);
    const { code, body } = await run(ctx, "epic", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
    const issues = body.error?.details["issues"] as { path: string; message: string }[];
    const found = issues.flatMap((issue) => [issue.path, `${issue.path}: ${issue.message}`]);
    expect(found).toContain(path);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no -f", ["epic", "edit", "ALPHA-12"]],
    ["no key", ["epic", "edit", "-f", "edit.json"]],
    ["an empty key", ["epic", "edit", " ", "-f", "edit.json"]],
    ["a .. key", ["epic", "edit", "..", "-f", "edit.json"]],
    ["two keys", ["epic", "edit", "ALPHA-12", "ALPHA-13", "-f", "edit.json"]],
    ["an unknown --kind", ["ticket", "edit", "ALPHA-12", "--kind", "saga", "-f", "edit.json"]],
  ])("usage: edit with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [epic, list] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["epic", "list"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Epics (3 displayed)", "ALPHA-12", "backlog"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [epic, show, ALPHA-12] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const argv = ["epic", "show", "ALPHA-12"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Epic", "Prerequisites", "ALPHA-12"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);
