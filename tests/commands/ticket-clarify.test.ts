import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
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

const META = {
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

/** The clarification ALPHA-7's refine gate is parked on. */
const OPEN = {
  ticket_id: "TKT-example-7",
  intervention_id: "INT-example-1",
  gate_id: "GATE-example-1",
  gate_generation: 3,
  stale: false,
  questions: [
    {
      key: "login_method",
      prompt: "How do people sign in?",
      answer_type: "single_select",
      choices: ["password", "magic_link"],
      required: true,
      target: "objective",
    },
    {
      key: "remember_me",
      prompt: "Should the session be remembered?",
      answer_type: "boolean",
      choices: [],
      required: false,
      target: "acceptance_criteria",
    },
  ],
};

const ANSWERS = {
  answers: { login_method: "password", remember_me: true },
  note: "Agreed with the product owner.",
};

const RESULT = {
  ticket_id: "TKT-example-7",
  outcome: "answered",
  assumptions_written: ["objective: password", "acceptance_criteria: remember_me=true"],
  gate_generation: 3,
  intervention_id: "INT-example-1",
  resolved_by: "human:user-example",
  gate_signalled: true,
  decision: null,
  refinement_command_id: "CMD-example-1",
  refine_workflow_id: "WFR-example-9",
  dispatch_error: null,
};

function ok(status: number, data: unknown, requestId: string) {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": requestId, "pidgen-api-version": "1.0" },
  );
}

function publicError(status: number, code: string, message: string) {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details: null, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

const NO_CLARIFICATION = () =>
  publicError(404, "CLARIFICATION_NOT_FOUND", "The Ticket has no open clarification.");

/** ALPHA-7 is parked on OPEN; ALPHA-8 exists with no open question; others are unknown. */
function server(call: Call): Response {
  const match = /^\/api\/v1\/tickets\/([^/]+)\/clarification$/.exec(call.url.pathname);
  if (!match) return publicError(404, "NOT_FOUND", "No such route.");
  if (match[1] === "ALPHA-8") return NO_CLARIFICATION();
  if (match[1] !== "ALPHA-7") return publicError(404, "TICKET_NOT_FOUND", "No such Ticket.");
  if (call.method === "GET") return ok(200, OPEN, "req_fake_read");
  if (call.method === "POST") return ok(202, RESULT, "req_fake_answer");
  return publicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
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

/** Serves OPEN for the read, then answers the POST with `answer`. */
function answering(answer: () => Response, open: unknown = OPEN) {
  return (call: Call) => (call.method === "GET" ? ok(200, open, "req_fake_read") : answer());
}

describe("pidgen ticket clarify", () => {
  it("clarify sends the answers for a parked clarification with its gate generation", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: RESULT,
      error: null,
      meta: { ...META, request_id: "req_fake_answer" },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/tickets/ALPHA-7/clarification"],
      ["POST", "/api/v1/tickets/ALPHA-7/clarification"],
    ]);
    expect(calls[1]?.body).toEqual({ ...ANSWERS, gate_generation: 3 });
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        "x-pidgen-account": "ACC-EXAMPLE",
      });
    }
  });

  it("clarify sends YAML answers from standard input as written, keeping their generation", async () => {
    const { ctx, calls } = await setup();
    ctx.readStdin = () =>
      Promise.resolve("answers:\n  login_method: magic_link\ngate_generation: 3\n");
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: RESULT });
    expect(calls[1]?.body).toEqual({ answers: { login_method: "magic_link" }, gate_generation: 3 });
  });

  it("clarify abandons a parked clarification without answers", async () => {
    const abandoned = { ...RESULT, outcome: "abandoned", assumptions_written: [] };
    const { ctx, calls } = await setup({
      respond: answering(() => ok(202, abandoned, "req_fake_answer")),
    });
    const name = await file(ctx, "abandon.json", { outcome: "abandoned", note: "Out of scope." });
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: abandoned });
    expect(calls[1]?.body).toEqual({
      outcome: "abandoned",
      note: "Out of scope.",
      gate_generation: 3,
    });
  });

  it("clarify's abandon result carries the hold the server placed, and the question stays open", async () => {
    const hold = {
      hold_id: "hold-example",
      ticket_id: "TKT-example-7",
      scope: "decision",
      cause: { kind: "decision", decision_key: "decision-example" },
      held_ticket_ids: ["TKT-example-7"],
      reason: "Out of scope.",
      requested_by: { kind: "user", user_id: "user-example", display_name: "Example User" },
      state: "requested",
      requested_at: "2026-10-05T08:00:00Z",
      confirmed_at: null,
      capacity_released_at: null,
      review_at: "2026-10-12T08:00:00Z",
      released_at: null,
      released_by: null,
    };
    const abandoned = { ...RESULT, outcome: "abandoned", assumptions_written: [], hold };
    const { ctx } = await setup({
      respond: answering(() => ok(202, abandoned, "req_fake_answer")),
    });
    const name = await file(ctx, "abandon.json", { outcome: "abandoned", note: "Out of scope." });
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: { outcome: "abandoned", hold } });
  });

  it("clarify's answered result carries no hold", async () => {
    const { ctx } = await setup({
      respond: answering(() => ok(202, { ...RESULT, hold: null }, "req_fake_answer")),
    });
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: { outcome: "answered", hold: null } });
  });

  it("clarify's help says that abandoned now places a hold and leaves the question open", async () => {
    const ctx = await testContext();
    expect(await runCli(["ticket", "clarify", "--help"], ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    expect(help).toMatch(/abandoned/);
    expect(help).toMatch(/places a hold/);
    expect(help).toMatch(/question open/);
    expect(help).toMatch(/deprecated/);
  });

  it("clarify with no live gate sends the answers without a generation", async () => {
    const { ctx, calls } = await setup({
      respond: answering(() => ok(202, RESULT, "req_fake_answer"), {
        ...OPEN,
        gate_id: null,
        gate_generation: null,
      }),
    });
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual(ANSWERS);
  });

  it("refused: clarifying a ticket with no open question exits 5 and sends no answers", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-8", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "CLARIFICATION_NOT_FOUND",
        message: "The Ticket has no open clarification.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refused: a clarification closed before the answer arrives exits 5", async () => {
    const { ctx } = await setup({ respond: answering(NO_CLARIFICATION) });
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, error: { code: "CLARIFICATION_NOT_FOUND" } });
  });

  it("refused: a stale clarification exits 5 with INTERVENTION_STALE and sends no answers", async () => {
    const { ctx, calls } = await setup({
      respond: answering(() => ok(202, RESULT, "req_fake_answer"), {
        ...OPEN,
        stale: true,
        questions: [],
      }),
    });
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "INTERVENTION_STALE",
        details: { request_id: "req_fake_read", intervention_id: "INT-example-1" },
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refused: the server's INTERVENTION_STALE (409) exits 5 with its code", async () => {
    const { ctx } = await setup({
      respond: answering(() =>
        publicError(409, "INTERVENTION_STALE", "The open clarification is from an earlier gate."),
      ),
    });
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INTERVENTION_STALE", details: { status: 409 } },
    });
  });

  it("refused: answers to a gate generation that moved on (422) exit 2 with the server's code", async () => {
    const { ctx } = await setup({
      respond: answering(() =>
        publicError(422, "CLARIFICATION_GENERATION_STALE", "The gate has moved on."),
      ),
    });
    const name = await file(ctx, "answers.json", { ...ANSWERS, gate_generation: 2 });
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "CLARIFICATION_GENERATION_STALE", details: { status: 422 } },
    });
  });

  it("refused: an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-999", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no -f", ["ticket", "clarify", "ALPHA-7"]],
    ["no ref", ["ticket", "clarify", "-f", "answers.json"]],
    ["an empty ref", ["ticket", "clarify", " ", "-f", "answers.json"]],
    ["a .. ref", ["ticket", "clarify", "..", "-f", "answers.json"]],
    ["two refs", ["ticket", "clarify", "ALPHA-7", "ALPHA-8", "-f", "answers.json"]],
  ])("usage: clarify with %s exits 2 with CLI_USAGE and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no answers", { note: "Nothing yet." }],
    ["an empty answers map", { answers: {} }],
    ["answers that are not a map", { answers: ["password"] }],
    ["an unknown outcome", { outcome: "maybe", answers: { login_method: "password" } }],
    ["a field the schema does not name", { answers: { login_method: "password" }, extra: 1 }],
  ])("usage: clarify with %s exits 2 with INPUT_INVALID and sends nothing", async (_, content) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", content);
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
    expect(Array.isArray(body.error?.details["issues"])).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("usage: clarify with an answers file that does not parse exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", "{ not json");
    const { code, body } = await run(ctx, "ticket", "clarify", "ALPHA-7", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
    expect(calls).toHaveLength(0);
  });
});
