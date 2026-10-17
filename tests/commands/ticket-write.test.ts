import { expectMutationParity } from "../support/context.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { PUBLIC_API_DOCUMENT } from "../../src/commands/api/document.js";
import { MANIFEST_DOCUMENT, MANIFEST_PREVIEW_ROUTE } from "../../src/commands/manifest/contract.js";
import { PREVIEW_TEMPLATE } from "../../src/commands/plan/apply.js";
import { PLAN_TEMPLATE_YAML } from "../../src/commands/plan/template.js";
import { CREATE_ROUTE } from "../../src/commands/ticket/create.js";
import { DEFAULT_TEMPLATE_FILE, TICKET_TEMPLATE } from "../../src/commands/ticket/template.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { validateBody } from "../../src/core/input.js";
import type { components } from "../../src/generated/api.js";
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

const NEW_TICKET = {
  title: "Show the login page",
  objective: "People can sign in from the home page.",
  project_id: "ALPHA",
  acceptance_criteria: [
    {
      statement: "The login page renders",
      assertion: "Opening the home page shows the sign-in form",
      priority: "MUST",
    },
  ],
};

const CREATED = {
  id: "TKT-example-7",
  ticket_key: "ALPHA-7",
  account_id: "ACC-EXAMPLE",
  project_id: "proj-example-a",
  version: 0,
  stage: "backlog",
  title: NEW_TICKET.title,
  objective: NEW_TICKET.objective,
  refinement_command_id: null,
  command_error: null,
};

const CURRENT = {
  id: "TKT-example-12",
  ticket_key: "ALPHA-12",
  account_id: "ACC-EXAMPLE",
  project_id: "proj-example-a",
  version: 4,
  stage: "backlog",
  title: "Ticket 12",
  objective: "The old objective.",
  priority: 5,
  team_member_id: "AGENT-EXAMPLE-CURRENT",
};

const EDIT_META = {
  root_ticket_id: "TKT-example-12",
  admission_invalidated: true,
  root_stage: "implementation_ready",
  plan_revised: true,
  review_required: true,
  planning_restarted: false,
};

function ok(status: number, data: unknown, meta: unknown = null, requestId = "req_fake_ok") {
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

/** Answers `POST /tickets`, and `GET`/`PATCH /tickets/ALPHA-12` as a ticket at version 4. */
function server(call: Call): Response {
  const path = call.url.pathname;
  if (path === "/api/v1/tickets" && call.method === "POST") {
    return ok(201, CREATED, null, "req_fake_create");
  }
  if (path === "/api/v1/tickets/ALPHA-12" && call.method === "GET") {
    return ok(200, CURRENT, null, "req_fake_read");
  }
  if (path === "/api/v1/tickets/ALPHA-12" && call.method === "PATCH") {
    const changes = call.body as Record<string, unknown>;
    return ok(200, { ...CURRENT, ...changes, version: 5 }, EDIT_META, "req_fake_edit");
  }
  return publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account.");
}

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

const META = {
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

describe("documented Agent assignment inputs", () => {
  it("template assignment examples select an Agent only at creation, as the published API allows", () => {
    expect(parse(TICKET_TEMPLATE)).not.toHaveProperty("team_member_id");
    expect(TICKET_TEMPLATE).toContain("# team_member_id: AGENT-EXAMPLE");
    const ticket = parse(TICKET_TEMPLATE.replace("# team_member_id:", "team_member_id:"));
    expect(() =>
      validateBody(PUBLIC_API_DOCUMENT, CREATE_ROUTE.method, CREATE_ROUTE.path, ticket),
    ).not.toThrow();
    // The Agent is chosen at creation and may be changed later by an edit naming team_member_id.
    expect(TICKET_TEMPLATE).toContain("chosen when the ticket is created");
    expect(TICKET_TEMPLATE).toContain("an edit file naming team_member_id reassigns");
    expect(TICKET_TEMPLATE).not.toMatch(/team_member_id[^\n]*is refused/);
    expect(TICKET_TEMPLATE).toContain("Never put version in an edit");
    // A child may select its Agent: the template describes team_member_id without setting it.
    expect(PLAN_TEMPLATE_YAML).not.toMatch(/^\s*team_member_id:/m);
    expect(PLAN_TEMPLATE_YAML).toContain("Optional team_member_id selects this child's Agent");
  });

  it.each(["pidgen-file-ticket", "pidgen-decompose-plan"])(
    "the bundled %s assignment examples conform to the committed schemas",
    async (skill) => {
      const text = await readFile(
        new URL(`../../skills/${skill}/SKILL.md`, import.meta.url),
        "utf8",
      );
      const examples = [...text.matchAll(/```yaml\n([\s\S]*?)\n```/g)]
        .map((match) => parse(match[1]!) as Record<string, unknown>)
        .filter(
          (example) => "team_member_id" in example || "children" in example || "root" in example,
        );
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example).not.toHaveProperty("version");
        if ("root" in example) {
          // A ticket manifest selects the root's Agent (and optionally a child's) at creation.
          expect(() =>
            validateBody(MANIFEST_DOCUMENT, "post", MANIFEST_PREVIEW_ROUTE, { manifest: example }),
          ).not.toThrow();
          expect(example["root"]).not.toHaveProperty("version");
        } else if ("children" in example) {
          expect(() =>
            validateBody(PUBLIC_API_DOCUMENT, "post", PREVIEW_TEMPLATE, { plan: example }),
          ).not.toThrow();
          for (const child of example["children"] as Record<string, unknown>[]) {
            expect(child).not.toHaveProperty("team_member_id");
          }
        } else {
          // Only a creation selects an Agent; an edit file naming team_member_id is refused.
          expect(example).toHaveProperty("title");
          expect(() =>
            validateBody(PUBLIC_API_DOCUMENT, CREATE_ROUTE.method, CREATE_ROUTE.path, example),
          ).not.toThrow();
        }
      }
      expect(text).toMatch(/Account Agent ID, not a model name/);
      expect(text).toMatch(/chosen when the ticket is created/);
      expect(text).toMatch(/Project default, else the Account's/);
    },
  );

  it("command documentation explains assignment defaults, edit versions and server-owned active-run effects", async () => {
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    const ticket = text.slice(
      text.indexOf("- `pidgen ticket create -f"),
      text.indexOf("- `pidgen ticket template"),
    );
    const plan = text.slice(text.indexOf("### plan apply"), text.indexOf("### plan promote"));
    expect(ticket).toContain("team_member_id");
    expect(ticket).toContain("Project");
    expect(ticket).toContain("Account's reserved Unassigned Agent");
    expect(ticket).toContain("chosen when the ticket is created");
    expect(ticket).toContain("current `version`");
    expect(ticket).toContain("no automatic write retry");
    expect(plan).toContain("PLAN_ITEM_AGENT_FIXED");
  });
});

describe.each(["create"])("ticket %s Agent assignment refusals", (command) => {
  it.each([
    [409, "ASSIGNMENT_REFUSED", "eligibility", ExitCode.Refused],
    [403, "FORBIDDEN", "authorization", ExitCode.Auth],
    [409, "TEAM_MEMBER_ARCHIVED", "archived", ExitCode.Refused],
    [422, "TEAM_MEMBER_ARCHIVED", "archived-input", ExitCode.Usage],
    [404, "TEAM_MEMBER_NOT_FOUND", "unknown", ExitCode.NotFound],
    [404, "TEAM_MEMBER_NOT_FOUND", "foreign", ExitCode.NotFound],
  ])("preserves %s %s (%s) without retry or fallback", async (status, errorCode, reason, exit) => {
    const details = { reason, team_member_id: "AGENT-EXAMPLE" };
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, CURRENT)
          : publicError(status as number, errorCode as string, "Assignment declined.", details),
    });
    const input =
      command === "create"
        ? { ...NEW_TICKET, team_member_id: "AGENT-EXAMPLE" }
        : { team_member_id: "AGENT-EXAMPLE" };
    const name = await file(ctx, "assignment.json", input);
    const args = command === "create" ? [] : ["ALPHA-12"];
    const { code, body } = await run(ctx, "ticket", command, ...args, "-f", name);
    expect(code).toBe(exit);
    expect(body).toEqual({
      ok: false,
      data: null,
      error: {
        code: errorCode,
        message: "Assignment declined.",
        details: { ...details, status, request_id: "req_fake_error" },
      },
      meta: {
        cli_version: "0.0.0-test",
        account: null,
        profile: null,
        api_version: null,
        request_id: null,
      },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual(
      command === "create"
        ? [["POST", "/api/v1/tickets"]]
        : [
            ["GET", "/api/v1/tickets/ALPHA-12"],
            ["PATCH", "/api/v1/tickets/ALPHA-12"],
          ],
    );
  });
});

describe("pidgen ticket create", () => {
  it.each(["json", "yaml", "stdin-json", "stdin-yaml"])(
    "create forwards the selected Account Agent unchanged from %s",
    async (format) => {
      const { ctx, calls } = await setup();
      const ticket = { ...NEW_TICKET, team_member_id: "AGENT-EXAMPLE" };
      const text = format.endsWith("yaml") ? stringify(ticket) : JSON.stringify(ticket);
      const name = format.startsWith("stdin") ? "-" : await file(ctx, `ticket.${format}`, text);
      ctx.readStdin = async () => text;
      const { code, body } = await run(ctx, "ticket", "create", "-f", name);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, data: CREATED, error: null });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "POST", body: ticket });
      expect(calls[0]?.url.pathname).toBe("/api/v1/tickets");
    },
  );

  it.each([null, "AGENT-UNASSIGNED-EXAMPLE", "a".repeat(80)])(
    "create preserves compatible null and valid Agent ID %s",
    async (team_member_id) => {
      const { ctx, calls } = await setup();
      const ticket = { ...NEW_TICKET, team_member_id };
      const name = await file(ctx, "ticket.json", ticket);
      const { code, body } = await run(ctx, "ticket", "create", "-f", name);
      expect(code).toBe(ExitCode.Ok);
      expect(body.ok).toBe(true);
      expect(calls[0]?.body).toEqual(ticket);
    },
  );

  it("create sends the file's body to POST /tickets and returns the created ticket", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", NEW_TICKET);
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: CREATED,
      error: null,
      meta: { ...META, request_id: "req_fake_create" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets");
    expect(calls[0]?.body).toEqual(NEW_TICKET);
    expect(calls[0]?.body).not.toHaveProperty("team_member_id");
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("create reads YAML and sends the same body as the JSON file", async () => {
    const { ctx, calls } = await setup();
    const yaml = [
      "title: Show the login page",
      "objective: People can sign in from the home page.",
      "project_id: ALPHA",
      "acceptance_criteria:",
      "  - statement: The login page renders",
      "    assertion: Opening the home page shows the sign-in form",
      "    priority: MUST",
      "",
    ].join("\n");
    const name = await file(ctx, "ticket.yaml", yaml);
    const { code } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual(NEW_TICKET);
  });

  it("create reads the body from standard input with -f -", async () => {
    const { ctx, calls } = await setup();
    ctx.readStdin = () => Promise.resolve(JSON.stringify(NEW_TICKET));
    const { code, body } = await run(ctx, "ticket", "create", "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: CREATED });
    expect(calls[0]?.body).toEqual(NEW_TICKET);
  });

  it("create refused by the server (404 PROJECT_NOT_FOUND) keeps the code and exits 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "PROJECT_NOT_FOUND", "No such Project in the Account."),
    });
    const name = await file(ctx, "ticket.json", NEW_TICKET);
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "No such Project in the Account.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
  });

  it("create refused by the server (422 UNKNOWN_WORKFLOW_TYPE) exits 2", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "UNKNOWN_WORKFLOW_TYPE", "No such workflow type."),
    });
    const name = await file(ctx, "ticket.json", { ...NEW_TICKET, workflow_type: "shipping" });
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNKNOWN_WORKFLOW_TYPE" } });
  });

  it("create refused by the server (403 FORBIDDEN) exits 3", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not create tickets."),
    });
    const name = await file(ctx, "ticket.json", NEW_TICKET);
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ...[42, false, [], {}, "", "a".repeat(81)].map<[string, unknown, string]>((team_member_id) => [
      "with an invalid Agent ID",
      { ...NEW_TICKET, team_member_id },
      "$.team_member_id",
    ]),
    ["without title", { objective: "Only an objective." }, "$.title"],
    ["with an unknown field", { ...NEW_TICKET, source_user: "someone" }, "$"],
    ["with a wrong type", { ...NEW_TICKET, priority: "high" }, "$.priority"],
    [
      "with an empty criterion statement",
      { ...NEW_TICKET, acceptance_criteria: [{ statement: "" }] },
      "$.acceptance_criteria[0].statement",
    ],
    ["that is not an object", ["a", "list"], "$"],
  ])("create: an invalid body %s exits 2 before any request", async (_, value, path) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", value);
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { method: "POST", path: "/tickets" } },
    });
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain(path);
    expect(calls).toHaveLength(0);
  });

  it("create: an invalid body that does not parse exits 2 with its line and column", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", '{\n  "title": "x",\n  "objective": }\n');
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { format: "json", line: 3 } },
    });
    expect(calls).toHaveLength(0);
  });

  it("create: a missing file exits 2 with INPUT_INVALID and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "create", "-f", "missing.yaml");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { source: "missing.yaml" } },
    });
    expect(calls).toHaveLength(0);
  });

  it("usage: create without -f exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "create");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: create with an argument exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", NEW_TICKET);
    const { code, body } = await run(ctx, "ticket", "create", "ALPHA-1", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("create with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const name = await file(ctx, "ticket.json", NEW_TICKET);
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket edit", () => {
  it.each(["json", "yaml"])(
    "edit sends readiness fields unchanged beside the fetched version from %s",
    async (format) => {
      const { ctx, calls } = await setup();
      const changes = {
        success_metrics: [
          { name: "List check", target: "passes" },
          { name: "Results", target: "3", current: null, unit: "items" },
        ],
        context_artifacts: [
          { type: "code_reference", content: "See the list command tests." },
          {
            type: "research_finding",
            content: "  Preserve this text.\nAnd this line.  ",
            reference_url: "https://pidgen.example.com/reference",
            tier: "reference",
          },
        ],
        required_capabilities: ["typescript", "node"],
      };
      const name = await file(
        ctx,
        `edit.${format}`,
        format === "yaml" ? stringify(changes) : changes,
      );
      const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toEqual({
        ok: true,
        data: { ...CURRENT, ...changes, version: 5, admission: EDIT_META },
        error: null,
        meta: { ...META, request_id: "req_fake_edit" },
      });
      expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
        ["GET", "/api/v1/tickets/ALPHA-12"],
        ["PATCH", "/api/v1/tickets/ALPHA-12"],
      ]);
      expect(calls[1]?.body).toEqual({ version: CURRENT.version, ...changes });
    },
  );

  it.each([{ label: "empty", value: [] }])(
    "edit forwards $label readiness fields",
    async ({ value }) => {
      const { ctx, calls } = await setup();
      const changes = {
        success_metrics: value,
        context_artifacts: value,
        required_capabilities: value,
      };
      const name = await file(ctx, "edit.yaml", stringify(changes));
      const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, error: null, data: changes });
      expect(calls[1]?.body).toEqual({ version: CURRENT.version, ...changes });
    },
  );

  it.each([
    ["success_metrics", [{ target: "passes" }]],
    ["success_metrics", [{ name: "List check" }]],
    ["context_artifacts", [{ type: "code_reference" }]],
    ["context_artifacts", [{ content: "See the list command tests." }]],
    ["required_capabilities", [42]],
    ["required_capabilities", "typescript"],
    // A list replaces the ticket's list; null is not a list, so the server would refuse it.
    ["success_metrics", null],
    ["context_artifacts", null],
    ["required_capabilities", null],
  ])("edit refuses invalid readiness field %s: %j locally", async (field, value) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.yaml", stringify({ [field as string]: value }));
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { method: "PATCH", path: "/tickets/{ticket_id}" } },
    });
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.some((issue) => issue.path.startsWith(`$.${field}`))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("edit help documents readiness fields as whole-list replacements", async () => {
    const { ctx, calls } = await setup();
    expect(await runCli(["ticket", "edit", "--help"], ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    for (const field of ["success_metrics", "context_artifacts", "required_capabilities"]) {
      expect(help).toContain(field);
    }
    expect(help).toContain("whole-list replacements");
    expect(calls).toHaveLength(0);
  });

  it("edit skill repairs readiness fields on the existing Ticket and allows Agent reassignment", async () => {
    const raw = await readFile(
      new URL("../../skills/pidgen-file-ticket/SKILL.md", import.meta.url),
      "utf8",
    );
    const section = raw.split("## Edit an existing Ticket\n")[1]!.split("\n## ")[0]!;
    expect(section).toContain("readiness threshold");
    expect(section).toContain("rather than filing a replacement");
    expect(section).toContain("whole-list replacements");
    expect(section).toMatch(/`team_member_id` reassigns/);
    expect(raw).not.toContain("naming `team_member_id` exits 2");
    expect(raw).not.toContain("public API has no edit of a ticket's Agent");
    const example = parse(section.match(/```yaml\n([\s\S]*?)\n```/)![1]!) as Record<
      string,
      unknown
    >;
    for (const field of ["success_metrics", "context_artifacts", "required_capabilities"]) {
      expect(example[field]).toBeInstanceOf(Array);
      expect(example[field]).not.toHaveLength(0);
    }
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.yaml", stringify(example));
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(calls[1]?.body).toEqual({ version: CURRENT.version, ...example });
  });

  it.each(["AGENT-EXAMPLE", "AGENT-UNASSIGNED-EXAMPLE"])(
    "edit: a file naming team_member_id %s passes the published edit request and is sent in the PATCH body",
    async (team_member_id) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "edit.yaml", stringify({ team_member_id }));
      const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, data: { team_member_id, version: 5 }, error: null });
      expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
      expect(calls[1]?.body).toEqual({ version: 4, team_member_id });
    },
  );

  it("edit: team_member_id is sent beside the other changed fields", async () => {
    const { ctx, calls } = await setup();
    const changes = { priority: 2, team_member_id: "AGENT-EXAMPLE" };
    const name = await file(ctx, "edit.json", changes);
    const { code } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual({ version: 4, ...changes });
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["over 80 characters", "a".repeat(81)],
    ["not text", 42],
  ])(
    "edit: a team_member_id that is %s fails the published edit request and exits 2 before any request",
    async (_, team_member_id) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "edit.json", { team_member_id });
      const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
      const issues = body.error?.details["issues"] as { path: string }[];
      expect(issues.map((issue) => issue.path)).toContain("$.team_member_id");
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    [404, "TEAM_MEMBER_NOT_FOUND", ExitCode.NotFound],
    [422, "TEAM_MEMBER_ARCHIVED", ExitCode.Usage],
    [409, "ASSIGNMENT_REFUSED", ExitCode.Refused],
  ])(
    "edit: the server's %s %s for the named Agent is reported with its code",
    async (status, errorCode, exit) => {
      const { ctx, calls } = await setup({
        respond: (call) =>
          call.method === "GET"
            ? ok(200, CURRENT)
            : publicError(status, errorCode, "The Agent cannot be assigned.", {
                team_member_id: "AGENT-EXAMPLE",
              }),
      });
      const name = await file(ctx, "edit.yaml", "team_member_id: AGENT-EXAMPLE\n");
      const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
      expect(code).toBe(exit);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: errorCode } });
      expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    },
  );

  it("edit reads the ticket, then sends its current version with the changed fields", async () => {
    const { ctx, calls } = await setup();
    const changes = { objective: "The new objective.", priority: 2 };
    const name = await file(ctx, "edit.json", changes);
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: { ...CURRENT, ...changes, version: 5, admission: EDIT_META },
      error: null,
      meta: { ...META, request_id: "req_fake_edit" },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-12"],
      ["PATCH", "/api/v1/tickets/ALPHA-12"],
    ]);
    expect(calls[1]?.body).toEqual({ version: 4, ...changes });
    expect(calls[1]?.body).not.toHaveProperty("team_member_id");
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        "x-pidgen-account": "ACC-EXAMPLE",
      });
    }
  });

  it("edit reports admission as null when the server's meta is null", async () => {
    const { ctx } = await setup({
      respond: (call) =>
        call.method === "GET" ? ok(200, CURRENT) : ok(200, { ...CURRENT, version: 5 }, null),
    });
    const name = await file(ctx, "edit.yaml", "priority: 3\n");
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ version: 5, admission: null });
  });

  it.each([
    ["JSON", "edit.json", { title: "A clearer title" }],
    ["YAML", "edit.yaml", "title: A clearer title\n"],
  ])(
    "edit: a %s file naming only title sends it with the ticket's current version",
    async (_, fileName, content) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, fileName, content);
      const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
      expect(code).toBe(ExitCode.Ok);
      expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
        ["GET", "/api/v1/tickets/ALPHA-12"],
        ["PATCH", "/api/v1/tickets/ALPHA-12"],
      ]);
      expect(calls[1]?.body).toEqual({ version: 4, title: "A clearer title" });
      expect(body).toMatchObject({
        ok: true,
        error: null,
        data: { title: "A clearer title", version: 5, admission: EDIT_META },
      });
    },
  );

  it("edit: a title is sent as written, beside the other fields", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", { title: "  Padded title  ", priority: 3 });
    const { code } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual({ version: 4, title: "  Padded title  ", priority: 3 });
  });

  it("edit prints meta.planning_restarted in data.admission", async () => {
    const restarted = {
      root_ticket_id: "TKT-example-12",
      admission_invalidated: false,
      root_stage: "planning",
      plan_revised: false,
      review_required: false,
      planning_restarted: true,
    };
    const { ctx } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, CURRENT)
          : ok(200, { ...CURRENT, title: "Renamed", version: 5 }, restarted, "req_fake_edit"),
    });
    const name = await file(ctx, "edit.json", { title: "Renamed" });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ title: "Renamed", admission: restarted });
    expect((body.data as { admission: { planning_restarted: boolean } }).admission).toHaveProperty(
      "planning_restarted",
      true,
    );
  });

  it("edit: a version conflict (409 CONFLICT) exits 5 with the server's details", async () => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, CURRENT)
          : publicError(409, "CONFLICT", "The Ticket changed since it was read.", {
              expected_version: 4,
              actual_version: 5,
            }),
    });
    const name = await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "CONFLICT",
        message: "The Ticket changed since it was read.",
        details: {
          status: 409,
          request_id: "req_fake_error",
          expected_version: 4,
          actual_version: 5,
        },
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]?.body).toEqual({ version: 4, priority: 2 });
  });

  it("edit: a stage that cannot be edited (409 EDIT_STAGE_NOT_ALLOWED) is a conflict, exit 5 with the refused field and stage", async () => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, CURRENT)
          : publicError(409, "EDIT_STAGE_NOT_ALLOWED", "The Ticket's stage is not editable.", {
              field: "priority",
              stage: "in_execution",
            }),
    });
    const name = await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "EDIT_STAGE_NOT_ALLOWED",
        message: "The Ticket's stage is not editable.",
        details: { status: 409, field: "priority", stage: "in_execution" },
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
  });

  it("edit: a stage refusal without details (an older server) is still a conflict, exit 5", async () => {
    const { ctx } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, CURRENT)
          : publicError(409, "EDIT_STAGE_NOT_ALLOWED", "The Ticket's stage is not editable."),
    });
    const name = await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, error: { code: "EDIT_STAGE_NOT_ALLOWED" } });
  });

  it("edit: a merged pull request (409 EDIT_MERGE_POLICY_LOCKED) is a conflict, exit 5 with the refused field", async () => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, CURRENT)
          : publicError(
              409,
              "EDIT_MERGE_POLICY_LOCKED",
              "The pull request is merged; the merge policy can no longer change.",
              { field: "merge_policy", stage: "completed" },
            ),
    });
    const name = await file(ctx, "edit.json", { merge_policy: "auto" });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "EDIT_MERGE_POLICY_LOCKED",
        details: { status: 409, field: "merge_policy", stage: "completed" },
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]?.body).toEqual({ version: 4, merge_policy: "auto" });
  });

  it("edit of an unknown ticket exits 4 with TICKET_NOT_FOUND and sends no PATCH", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-99", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("edit: a ticket read without a version exits 1 and sends no PATCH", async () => {
    const unversioned = Object.fromEntries(
      Object.entries(CURRENT).filter(([key]) => key !== "version"),
    );
    const { ctx, calls } = await setup({ respond: () => ok(200, unversioned) });
    const name = await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, error: { code: "UNEXPECTED_RESPONSE" } });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it.each([
    ["with an unknown field", { stage: "backlog" }, "$"],
    ["with an empty title", { title: "" }, "$.title"],
    ["with a blank title", { title: "   " }, "$.title"],
    ["with a title that is not text", { title: 7 }, "$.title"],
    ["with a priority out of range", { priority: 11 }, "$.priority"],
    ["with an empty objective", { objective: "" }, "$.objective"],
    ["that is not an object", "just text\n", "$"],
  ])("edit: an invalid body %s exits 2 before any request", async (_, value, path) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.yaml", value);
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain(path);
    expect(calls).toHaveLength(0);
  });

  it("edit: an invalid body naming version exits 2 before any request", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", { version: 3, priority: 2 });
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { issues: [{ path: "$.version" }] } },
    });
    expect(calls).toHaveLength(0);
  });

  it("edit: an invalid body with no field to change exits 2 before any request", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "edit.json", {});
    const { code, body } = await run(ctx, "ticket", "edit", "ALPHA-12", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no ref", ["ticket", "edit", "-f", "edit.json"]],
    ["an empty ref", ["ticket", "edit", " ", "-f", "edit.json"]],
    ["a .. ref", ["ticket", "edit", "..", "-f", "edit.json"]],
    ["two refs", ["ticket", "edit", "ALPHA-12", "ALPHA-13", "-f", "edit.json"]],
    ["no -f", ["ticket", "edit", "ALPHA-12"]],
  ])("usage: edit with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    await file(ctx, "edit.json", { priority: 2 });
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket template", () => {
  it("template writes ticket.yaml in the working directory and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "template");
    expect(code).toBe(ExitCode.Ok);
    const path = join(ctx.cwd, DEFAULT_TEMPLATE_FILE);
    expect(body).toMatchObject({
      ok: true,
      data: { path, format: "yaml" },
      error: null,
      meta: { cli_version: "0.0.0-test" },
    });
    expect(await readFile(path, "utf8")).toBe(TICKET_TEMPLATE);
    expect(calls).toHaveLength(0);
  });

  it("template writes a file that ticket create accepts and sends unchanged", async () => {
    const { ctx, calls } = await setup();
    const written = await run(ctx, "ticket", "template", "-o", "new-ticket.yaml");
    expect(written.code).toBe(ExitCode.Ok);
    const { code, body } = await run(ctx, "ticket", "create", "-f", "new-ticket.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: CREATED });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual(parse(TICKET_TEMPLATE));
  });

  it("template: every field it names matches the create request schema and is annotated", () => {
    const value = parse(TICKET_TEMPLATE) as Record<string, unknown>;
    expect(
      validateBody(PUBLIC_API_DOCUMENT, CREATE_ROUTE.method, CREATE_ROUTE.path, value),
    ).toEqual(value);
    const lines = TICKET_TEMPLATE.split("\n");
    for (const key of Object.keys(value)) {
      const index = lines.findIndex((line) => line.startsWith(`${key}:`));
      expect(lines[index - 1], key).toMatch(/^#/);
    }
  });

  it("template places the ticket in an Epic by parent_ticket_id, never epic_id", () => {
    const value = parse(TICKET_TEMPLATE) as Record<string, unknown>;
    expect(value).toHaveProperty("parent_ticket_id", null);
    expect(value).not.toHaveProperty("epic_id");
    expect(TICKET_TEMPLATE).not.toMatch(/epic_id|EXAMPLE-E\d/);
    expect(TICKET_TEMPLATE).toContain("--kind epic");
  });

  /** The comment block directly above a top-level key of the template. */
  function annotation(key: string): string {
    const lines = TICKET_TEMPLATE.split("\n");
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    expect(index, key).toBeGreaterThan(0);
    const comments: string[] = [];
    for (let at = index - 1; at >= 0 && lines[at]!.startsWith("#"); at--) {
      comments.unshift(lines[at]!.replace(/^#\s?/, ""));
    }
    return comments.join(" ");
  }

  it("template: estimated_complexity, context_artifacts and required_capabilities are written, each with the readiness points it earns", () => {
    const value = parse(TICKET_TEMPLATE) as Record<string, unknown>;
    for (const key of ["estimated_complexity", "context_artifacts", "required_capabilities"]) {
      expect(value, key).toHaveProperty(key);
      expect(annotation(key), key).toMatch(/Readiness: /);
    }
    // Complexity earns nothing itself, but a ticket without it is never ready to execute.
    expect(value["estimated_complexity"]).toEqual(expect.any(Number));
    expect(annotation("estimated_complexity")).toMatch(/Readiness: no points/);
    expect(annotation("estimated_complexity")).toMatch(/never ready/);
    // Context artifacts earn 5 points each, at most 15.
    expect(value["context_artifacts"]).toEqual([]);
    expect(annotation("context_artifacts")).toMatch(/Readiness: 5 points each, at most 15/);
    // Capabilities are matched to the Agent, not scored.
    expect(value["required_capabilities"]).toEqual([]);
    expect(annotation("required_capabilities")).toMatch(/Readiness: no points/);
    // The scored fields name their points too, and the header the threshold they add up to.
    expect(annotation("acceptance_criteria")).toMatch(
      /Readiness: 10 points per criterion, at most 30/,
    );
    expect(annotation("acceptance_criteria")).toMatch(/5 more per MUST criterion, at most 20/);
    expect(annotation("scope_boundaries")).toMatch(/Readiness: 10 points/);
    expect(annotation("success_metrics")).toMatch(/Readiness: 10 points/);
    expect(annotation("open_questions")).toMatch(/Readiness: minus 5 points per question/);
    expect(TICKET_TEMPLATE).toMatch(/needs 60 of 100/);
  });

  it("template: a commented context artifact example is valid for ticket create once uncommented", () => {
    const uncommented = TICKET_TEMPLATE.replace(
      /^context_artifacts: \[\]\n((?:#.*\n)+)/m,
      (_, block: string) => `context_artifacts:\n${block.replace(/^# ?/gm, "")}`,
    );
    const value = parse(uncommented) as Record<string, unknown>;
    const artifacts = value["context_artifacts"] as unknown[];
    expect(artifacts.length).toBeGreaterThan(0);
    expect(
      validateBody(PUBLIC_API_DOCUMENT, CREATE_ROUTE.method, CREATE_ROUTE.path, value),
    ).toEqual(value);
  });

  it("template: an existing file is kept and exits 2 without --force", async () => {
    const { ctx } = await setup();
    await file(ctx, "ticket.yaml", "title: mine\n");
    const { code, body } = await run(ctx, "ticket", "template");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", details: { option: "--output" } },
    });
    expect(await readFile(join(ctx.cwd, "ticket.yaml"), "utf8")).toBe("title: mine\n");
  });

  it("template --force overwrites an existing file", async () => {
    const { ctx } = await setup();
    await file(ctx, "ticket.yaml", "title: mine\n");
    const { code } = await run(ctx, "ticket", "template", "--force");
    expect(code).toBe(ExitCode.Ok);
    expect(await readFile(join(ctx.cwd, "ticket.yaml"), "utf8")).toBe(TICKET_TEMPLATE);
  });

  it("template into a missing directory exits 1 with CLI_INTERNAL", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "template", "-o", "no/such/dir/t.yaml");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_INTERNAL" } });
  });

  it.each([
    ["an empty --output", ["ticket", "template", "-o", " "]],
    ["an argument", ["ticket", "template", "extra"]],
    ["an unknown option", ["ticket", "template", "--format-version", "2"]],
  ])("usage: template with %s exits 2", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

/** The generated criterion types, with the fields the server defaults left optional. */
type Criterion = Pick<
  components["schemas"]["AcceptanceCriterion"],
  "statement" | "assertion" | "evidence" | "test_assertion"
>;
type CriterionInput = Pick<
  components["schemas"]["AcceptanceCriterionInput"],
  "statement" | "assertion" | "test_assertion"
>;

/** The acceptance criteria of a parsed template or plan child. */
function templateCriteria(value: unknown): Record<string, unknown>[] {
  return (value as { acceptance_criteria: Record<string, unknown>[] }).acceptance_criteria;
}

describe("acceptance criteria: statement, optional assertion, optional pinned test_assertion", () => {
  it("ticket template: every criterion has a statement and an assertion, and no test_assertion", () => {
    const criteria = templateCriteria(parse(TICKET_TEMPLATE));
    expect(criteria.length).toBeGreaterThan(0);
    for (const criterion of criteria) {
      expect(criterion["statement"]).toEqual(expect.any(String));
      expect(criterion["assertion"]).toEqual(expect.any(String));
      expect(criterion).not.toHaveProperty("test_assertion");
    }
    expect(TICKET_TEMPLATE).toMatch(/needs only a statement/);
    expect(TICKET_TEMPLATE).toMatch(/assertion is optional/);
    expect(TICKET_TEMPLATE).toMatch(/Advanced: add test_assertion only when/);
  });

  it("ticket template: create accepts a criterion with only a statement (assertion optional)", async () => {
    const value = {
      title: "Show the login page",
      objective: "People can sign in from the home page.",
      acceptance_criteria: [{ statement: "The login page renders" }],
    };
    expect(
      validateBody(PUBLIC_API_DOCUMENT, CREATE_ROUTE.method, CREATE_ROUTE.path, value),
    ).toEqual(value);
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", value);
    const { code } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual(value);
  });

  it("ticket create still sends a criterion with a pinned test_assertion check", async () => {
    const pinned = {
      ...NEW_TICKET,
      acceptance_criteria: [
        { statement: "The login page renders", test_assertion: "npm test -- login" },
      ],
    };
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", pinned);
    const { code } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual(pinned);
  });

  it("assertion: an assertion that is not a string exits 2 before any request", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "ticket.json", {
      ...NEW_TICKET,
      acceptance_criteria: [{ statement: "The login page renders", assertion: 7 }],
    });
    const { code, body } = await run(ctx, "ticket", "create", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain("$.acceptance_criteria[0].assertion");
    expect(calls).toHaveLength(0);
  });

  it("plan template: every child's criteria need only a statement, with no test_assertion", () => {
    const plan = parse(PLAN_TEMPLATE_YAML) as { children: Record<string, unknown>[] };
    expect(plan.children.length).toBeGreaterThan(1);
    const criteria = plan.children.flatMap((child) => templateCriteria(child));
    for (const criterion of criteria) {
      expect(criterion["statement"]).toEqual(expect.any(String));
      expect(criterion).not.toHaveProperty("test_assertion");
    }
    expect(criteria).toContainEqual({ statement: "The follow-up behaviour works as described." });
    expect(PLAN_TEMPLATE_YAML).toMatch(/needs only a statement/);
    expect(PLAN_TEMPLATE_YAML).toMatch(/Advanced: add test_assertion only when/);
    expect(() =>
      validateBody(PUBLIC_API_DOCUMENT, "post", PREVIEW_TEMPLATE, { plan }),
    ).not.toThrow();
  });

  it("plan: a child criterion with only a statement matches the plan request schema", () => {
    const plan = {
      children: [
        {
          key: "only",
          title: "Only child",
          objective: "Deliver the only slice.",
          workflow_type: "implementation",
          acceptance_criteria: [{ statement: "The slice works." }],
        },
      ],
    };
    expect(() =>
      validateBody(PUBLIC_API_DOCUMENT, "post", PREVIEW_TEMPLATE, { plan }),
    ).not.toThrow();
  });

  it("assertion and evidence are typed on the criterion the API returns", () => {
    const criterion: Criterion = {
      statement: "The login page renders",
      assertion: "Opening the home page shows the sign-in form",
      evidence: { artifact_id: "ART-example", section: "AC-1" },
    };
    const input: CriterionInput = { statement: "The login page renders", assertion: null };
    expect(criterion.evidence?.artifact_id).toBe("ART-example");
    expect(input.test_assertion).toBeUndefined();
  });
});

const OWNER_RESULT = {
  ticket_id: CURRENT.id,
  owner_user_id: "user-example",
  effective_owner: { user_id: "user-example", display_name: "Example User", source: "ticket" },
  version: 5,
};

describe("pidgen ticket owner", () => {
  it.each([
    [
      ["--user", "user-example", "--reason", "Taking responsibility"],
      "user-example",
      "Taking responsibility",
    ],
    [["--clear"], null, undefined],
  ])("sets or clears the owner with the current version: %j", async (flags, owner, reason) => {
    const result = {
      ...OWNER_RESULT,
      owner_user_id: owner,
      effective_owner:
        owner === null
          ? { user_id: "submitter-example", display_name: "Example Submitter", source: "submitter" }
          : OWNER_RESULT.effective_owner,
    };
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET" ? server(call) : ok(200, result, null, "req_fake_owner"),
    });
    const { code, body } = await run(ctx, "ticket", "owner", "ALPHA-12", ...flags);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: result,
      error: null,
      meta: { ...META, request_id: "req_fake_owner" },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-12"],
      ["PUT", "/api/v1/tickets/ALPHA-12/owner"],
    ]);
    expect(calls[1]?.body).toEqual({
      version: CURRENT.version,
      owner_user_id: owner,
      ...(reason === undefined ? {} : { reason }),
    });
    expect(calls[1]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it.each([
    [409, "CONFLICT", ExitCode.Refused],
    [422, "OWNER_NOT_ELIGIBLE", ExitCode.Refused],
    [422, "INPUT_INVALID", ExitCode.Usage],
    [403, "FORBIDDEN", ExitCode.Auth],
    [404, "NOT_FOUND", ExitCode.NotFound],
  ])("reports the PUT refusal %s %s", async (status, errorCode, exitCode) => {
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? server(call)
          : publicError(status, errorCode, "Owner change refused.", { actual_version: 5 }),
    });
    const { code, body } = await run(ctx, "ticket", "owner", "ALPHA-12", "--user", "user-example");
    expect(code).toBe(exitCode);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: errorCode,
        message: "Owner change refused.",
        details: { status, actual_version: 5, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(2);
  });

  it("stops when the initial ticket read returns 404", async () => {
    const { ctx, calls } = await setup({
      respond: () => publicError(404, "TICKET_NOT_FOUND", "No ticket."),
    });
    const { code, body } = await run(ctx, "ticket", "owner", "ALPHA-12", "--clear");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
    expect(calls).toHaveLength(1);
  });

  it.each([undefined, null, "4", -1, 1.5])(
    "does not PUT against an invalid current version %j",
    async (version) => {
      const { ctx, calls } = await setup({ respond: () => ok(200, { ...CURRENT, version }) });
      const { code, body } = await run(ctx, "ticket", "owner", "ALPHA-12", "--clear");
      expect(code).toBe(ExitCode.Unexpected);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNEXPECTED_RESPONSE" } });
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    [],
    ["ALPHA-12"],
    ["ALPHA-12", "--user", "user-example", "--clear"],
    ["ALPHA-12", "--user"],
    ["ALPHA-12", "--user", " "],
    [" ", "--clear"],
    [".", "--clear"],
    ["..", "--clear"],
    ["ALPHA-12", "extra", "--clear"],
    ["ALPHA-12", "--clear", "--reason"],
    ["ALPHA-12", "--clear", "--unknown"],
  ])("rejects usage %j without requests", async (...argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "ticket", "owner", ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe.each([
  ["follow", true],
  ["unfollow", false],
] as const)("pidgen ticket %s", (verb, following) => {
  it.each(["explicit", "owner", "administrator", null])(
    "sends the requested state and returns the server's result with source %s",
    async (source) => {
      // Removing explicit following may still leave effective following through ownership.
      const result = {
        ticket_id: CURRENT.id,
        following: following || source === "owner" || source === "administrator",
        source,
      };
      const { ctx, calls } = await setup({
        respond: () => ok(200, result, null, "req_fake_following"),
      });
      const { code, body } = await run(ctx, "ticket", verb, "ALPHA-12");
      expect(code).toBe(ExitCode.Ok);
      expect(body).toEqual({
        ok: true,
        data: result,
        error: null,
        meta: { ...META, request_id: "req_fake_following" },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("PUT");
      expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-12/following");
      expect(calls[0]?.body).toEqual({ following });
    },
  );

  it("reports 404 for an unreadable ticket or unavailable route", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "NOT_FOUND", "Not readable or unavailable."),
    });
    const { code, body } = await run(ctx, "ticket", verb, "ALPHA-12");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "NOT_FOUND", details: { status: 404 } },
    });
  });

  it.each([[], [" "], ["."], [".."], ["ALPHA-12", "extra"], ["ALPHA-12", "--unknown"]])(
    "rejects usage %j without requests",
    async (...argv) => {
      const { ctx, calls } = await setup();
      const { code, body } = await run(ctx, "ticket", verb, ...argv);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
      expect(calls).toHaveLength(0);
    },
  );
});

it.each([40, 80, 120])(
  "created ticket identity preserves the direct write at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    await writeFile(join(ctx.cwd, "new.json"), JSON.stringify(NEW_TICKET));
    const json = await expectMutationParity(
      ctx,
      calls,
      ["ticket", "create", "-f", "new.json"],
      ["ticket create", CREATED.ticket_key, CREATED.id],
    );
    expect(json.data).toEqual(CREATED);
    expect(calls).toHaveLength(1);
  },
);

it.each([40, 80, 120])("local template creation preserves files at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  ctx.io.stdoutIsTTY = true;
  expect(await runCli(["ticket", "template", "--output", "human.yaml"], ctx)).toBe(ExitCode.Ok);
  expect(ctx.out.join("")).toContain("Template created.");
  expect(ctx.out.join("")).toContain("human.yaml");
  expect(await readFile(join(ctx.cwd, "human.yaml"), "utf8")).toBe(TICKET_TEMPLATE);
  expect(calls).toEqual([]);
});
