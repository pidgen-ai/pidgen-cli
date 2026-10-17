import { expectMutationParity } from "../support/context.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import { intakeRequest } from "../support/requests.js";

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

const INTENT = {
  title: "Show the login page",
  objective: "People can sign in from the home page.",
  project_id: "ALPHA",
};

const CREATED = {
  outcome: "created",
  ticket_id: "TKT-example-7",
  ticket_key: "ALPHA-7",
  stage: "backlog",
  needs_clarification: false,
  ticket_url: "/tickets/ALPHA-7?account=ACC-EXAMPLE",
  target_lane: "backlog",
  auto_promotion: null,
  refinement_command_id: "CMD-example-1",
  command_error: null,
};

const CLARIFICATION = {
  outcome: "needs_clarification",
  ticket_id: null,
  stage: null,
  needs_clarification: true,
  conversation_id: "conv-example-1",
  questions: ["Which login methods?", "Should it remember the user?"],
};

const STILL_NEEDS = {
  outcome: "still_needs_clarification",
  ticket_id: null,
  stage: null,
  still_need_clarification: true,
  message: "Answer the remaining questions, or respond with delegate.",
};

const ANSWERS = {
  answers: [
    { question_index: 0, answer: "Email and password." },
    { question_index: 1, answer: "Yes, for 30 days." },
  ],
};

const WITHDRAWN_REQUEST = intakeRequest({
  state: "withdrawn",
  withdrawn: {
    by: { user_id: "usr-example-1", display_name: "Example Person" },
    at: "2026-10-02T10:00:00Z",
    reason: "Duplicate of ALPHA-3.",
  },
  version: 4,
});

function ok(status: number, data: unknown, requestId = "req_fake_ok") {
  return jsonResponse(
    status,
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

/** Creates the ticket at once for `POST /intents`, and for answers to `conv-example-1`. */
function server(call: Call): Response {
  const path = call.url.pathname;
  if (path === "/api/v1/intents" && call.method === "POST") {
    return ok(201, CREATED, "req_fake_submit");
  }
  if (path === "/api/v1/intents/conv-example-1/respond" && call.method === "POST") {
    return ok(200, CREATED, "req_fake_respond");
  }
  return publicError(404, "CONVERSATION_NOT_FOUND", "No such request in the Account.");
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

describe("pidgen intent submit", () => {
  it("submit sends the file's body to POST /intents and returns the created ticket", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: CREATED,
      error: null,
      meta: { ...META, request_id: "req_fake_submit" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents");
    expect(calls[0]?.body).toEqual(INTENT);
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("submit reads YAML from standard input and returns the created ticket", async () => {
    const { ctx, calls } = await setup();
    ctx.readStdin = () =>
      Promise.resolve(
        [
          "title: Show the login page",
          "objective: People can sign in from the home page.",
          "project_id: ALPHA",
          "",
        ].join("\n"),
      );
    const { code, body } = await run(ctx, "intent", "submit", "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: CREATED });
    expect(calls[0]?.body).toEqual(INTENT);
  });

  it("submit returns the conversation and its questions when clarification is needed", async () => {
    const { ctx } = await setup({ respond: () => ok(201, CLARIFICATION, "req_fake_submit") });
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: CLARIFICATION,
      error: null,
      meta: { ...META, request_id: "req_fake_submit" },
    });
    const data = body.data as typeof CLARIFICATION;
    expect(data.conversation_id).toBe("conv-example-1");
    expect(data.questions).toEqual(CLARIFICATION.questions);
  });

  it("submit --submission-key sends the key as submission_key and leaves the result unchanged", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(
      ctx,
      "intent",
      "submit",
      "-f",
      name,
      "--submission-key",
      "key-example-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: CREATED,
      error: null,
      meta: { ...META, request_id: "req_fake_submit" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ ...INTENT, submission_key: "key-example-1" });
  });

  it("submit keeps a submission_key the file already has when --submission-key is not given", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", { ...INTENT, submission_key: "key-from-file" });
    const { code } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ ...INTENT, submission_key: "key-from-file" });
  });

  it("submit --submission-key replaces the file's own submission_key", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", { ...INTENT, submission_key: "key-from-file" });
    const { code } = await run(
      ctx,
      "intent",
      "submit",
      "-f",
      name,
      "--submission-key",
      "key-given",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ ...INTENT, submission_key: "key-given" });
  });

  it("submit --submission-key works for a body read from standard input", async () => {
    const { ctx, calls } = await setup();
    ctx.readStdin = () => Promise.resolve(JSON.stringify(INTENT));
    const { code } = await run(ctx, "intent", "submit", "-f", "-", "--submission-key", "key-stdin");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ ...INTENT, submission_key: "key-stdin" });
  });

  it("submit without --submission-key sends the file's body as written, with no key", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", INTENT);
    await run(ctx, "intent", "submit", "-f", name);
    expect(calls[0]?.body).not.toHaveProperty("submission_key");
  });

  it("submit returns the durable request and its structured questions when clarification is needed", async () => {
    const clarification = {
      ...CLARIFICATION,
      request_id: "conv-example-1",
      request: intakeRequest(),
    };
    const { ctx } = await setup({ respond: () => ok(201, clarification, "req_fake_submit") });
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name, "--submission-key", "k1");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(clarification);
  });

  it("submit refused by the server (409 SUBMISSION_KEY_REUSED) is a refusal, exit 5", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        publicError(409, "SUBMISSION_KEY_REUSED", "That key was used for a different request."),
    });
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name, "--submission-key", "k1");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "SUBMISSION_KEY_REUSED",
        message: "That key was used for a different request.",
        details: { status: 409, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["an empty key", ""],
    ["a blank key", "   "],
    ["a key over 200 characters", "k".repeat(201)],
  ])("usage: submit --submission-key with %s exits 2 and sends nothing", async (_, key) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name, "--submission-key", key);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", details: { option: "--submission-key" } },
    });
    expect(calls).toHaveLength(0);
  });

  it("usage: submit --submission-key without a value exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name, "--submission-key");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", message: expect.stringMatching(/argument missing/) },
    });
    expect(calls).toHaveLength(0);
  });

  it("submit: a body that is not an object with --submission-key is still INPUT_INVALID and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", ["a", "list"]);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name, "--submission-key", "k1");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
    expect(calls).toHaveLength(0);
  });

  it("submit refused by the server (404 PROJECT_NOT_FOUND) keeps the code and exits 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "PROJECT_NOT_FOUND", "No such Project in the Account."),
    });
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
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

  it("submit refused by the server (422 PROJECT_REQUIRED) exits 2", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "PROJECT_REQUIRED", "Name a Project."),
    });
    const name = await file(ctx, "intent.json", {
      title: INTENT.title,
      objective: INTENT.objective,
    });
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "PROJECT_REQUIRED" } });
  });

  it("submit refused by the server (403 FORBIDDEN) exits 3", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not create work."),
    });
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["without objective", { title: INTENT.title, project_id: "ALPHA" }, "$.objective"],
    ["with an empty title", { ...INTENT, title: "" }, "$.title"],
    ["with an unknown approval mode", { ...INTENT, approval_mode: "sometimes" }, "$.approval_mode"],
    ["that is not an object", ["a", "list"], "$"],
  ])("submit: an invalid body %s exits 2 before any request", async (_, value, path) => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", value);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { method: "POST", path: "/intents" } },
    });
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain(path);
    expect(calls).toHaveLength(0);
  });

  it("submit: a missing file exits 2 with INPUT_INVALID and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "intent", "submit", "-f", "missing.yaml");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { source: "missing.yaml" } },
    });
    expect(calls).toHaveLength(0);
  });

  it("usage: submit without -f exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "intent", "submit");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: submit with an argument exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "extra", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("submit with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const name = await file(ctx, "intent.json", INTENT);
    const { code, body } = await run(ctx, "intent", "submit", "-f", name);
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen intent respond", () => {
  it("respond sends the answers to the conversation and returns the created ticket", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: CREATED,
      error: null,
      meta: { ...META, request_id: "req_fake_respond" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv-example-1/respond");
    expect(calls[0]?.body).toEqual(ANSWERS);
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("respond reads YAML answers with delegate and sends them as written", async () => {
    const { ctx, calls } = await setup();
    const yaml = [
      "answers:",
      "  - question_index: 0",
      "    answer: Email and password.",
      "delegate: true",
      "",
    ].join("\n");
    const name = await file(ctx, "answers.yaml", yaml);
    const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: CREATED });
    expect(calls[0]?.body).toEqual({
      answers: [{ question_index: 0, answer: "Email and password." }],
      delegate: true,
    });
  });

  it("respond returns still_needs_clarification when questions remain", async () => {
    const { ctx } = await setup({ respond: () => ok(200, STILL_NEEDS, "req_fake_respond") });
    const name = await file(ctx, "answers.json", { answers: [ANSWERS.answers[0]] });
    const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: STILL_NEEDS,
      error: null,
      meta: { ...META, request_id: "req_fake_respond" },
    });
  });

  it("respond percent-encodes the conversation as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, CREATED) });
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code } = await run(ctx, "intent", "respond", "conv/../x", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv%2F..%2Fx/respond");
  });

  it("respond accepts question_id, an outcome and no answer text, and sends the body as written", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        ok(
          200,
          { ...STILL_NEEDS, request: intakeRequest({ assumption_count: 1 }) },
          "req_fake_respond",
        ),
    });
    const body = {
      answers: [
        { question_id: "q-example-1", outcome: "use_recommendation" },
        { question_id: "q-example-2", answer: "Yes, for 30 days." },
        { question_id: "q-example-3", outcome: "ask_teammate", ask_user_id: "usr-example-2" },
        { question_id: "q-example-4", outcome: "leave_open" },
        { question_index: 4, outcome: "answer", answer: "By index." },
      ],
    };
    const name = await file(ctx, "answers.json", body);
    const result = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.body).toMatchObject({
      ok: true,
      data: { outcome: "still_needs_clarification", request: { request_id: "conv-example-1" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv-example-1/respond");
    expect(calls[0]?.body).toEqual(body);
  });

  it("respond accepts empty answers with delegate and sends them as written", async () => {
    const created = { ...CREATED, request_id: "conv-example-1", assumptions_recorded: 2 };
    const { ctx, calls } = await setup({ respond: () => ok(200, created, "req_fake_respond") });
    const name = await file(ctx, "answers.json", { answers: [], delegate: true });
    const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: created,
      error: null,
      meta: { ...META, request_id: "req_fake_respond" },
    });
    expect(calls[0]?.body).toEqual({ answers: [], delegate: true });
  });

  it.each([
    [
      "REQUEST_WITHDRAWN",
      409,
      ExitCode.Refused,
      "The request was withdrawn, so it cannot be answered.",
    ],
    ["QUESTION_NOT_FOUND", 422, ExitCode.Usage, "The request has no such question."],
    ["ANSWER_EMPTY", 422, ExitCode.Usage, "An answer needs text."],
    ["NO_RECOMMENDATION", 422, ExitCode.Usage, "That question has no recommendation."],
    ["ASKEE_NOT_ELIGIBLE", 422, ExitCode.Usage, "That teammate cannot be asked."],
  ])(
    "respond refused by the server (%s) keeps the code and exits with the status's code",
    async (serverCode, status, exit, message) => {
      const { ctx, calls } = await setup({
        respond: () => publicError(status, serverCode, message),
      });
      const name = await file(ctx, "answers.json", {
        answers: [{ question_id: "q-example-1", outcome: "use_recommendation" }],
      });
      const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
      expect(code).toBe(exit);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: { code: serverCode, message, details: { status, request_id: "req_fake_error" } },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    ["no answers and no delegate", { answers: [] }, "$.answers"],
    ["no answers and delegate false", { answers: [], delegate: false }, "$.answers"],
    ["an answer naming no question", { answers: [{ answer: "Yes." }] }, "$.answers[0]"],
    [
      "an answer outcome with no answer text",
      { answers: [{ question_id: "q-example-1", outcome: "answer" }] },
      "$.answers[0]",
    ],
    [
      "a question with no outcome and no answer",
      { answers: [{ question_id: "q1" }] },
      "$.answers[0]",
    ],
    [
      "an unknown outcome",
      { answers: [{ question_id: "q1", outcome: "skip" }] },
      "$.answers[0].outcome",
    ],
    [
      "an empty question_id",
      { answers: [{ question_id: "", answer: "Yes." }] },
      "$.answers[0].question_id",
    ],
  ])(
    "usage: respond with %s exits 2 with INPUT_INVALID and sends nothing",
    async (_, value, path) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "answers.json", value);
      const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: {
          code: "INPUT_INVALID",
          details: { method: "POST", path: "/intents/{conversation_id}/respond" },
        },
      });
      const issues = body.error?.details["issues"] as { path: string }[];
      expect(issues.map((issue) => issue.path)).toContain(path);
      expect(calls).toHaveLength(0);
    },
  );

  it("respond's help names question_id and outcomes, and says the request does not expire", async () => {
    const ctx = await testContext();
    expect(await runCli(["intent", "respond", "--help"], ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    expect(help).toMatch(/question_id/);
    expect(help).toMatch(/use_recommendation/);
    expect(help).toMatch(/ask_teammate/);
    expect(help).toMatch(/leave_open/);
    expect(help).toMatch(/delegate/);
    expect(help).toMatch(/never expires/);
    expect(help).not.toMatch(/five minutes/);
  });

  it("respond to an unknown request (404 CONVERSATION_NOT_FOUND) is not found, exit 4", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "intent", "respond", "conv-expired", "-f", name);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "CONVERSATION_NOT_FOUND",
        message: "No such request in the Account.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("respond refused by the server (422 QUESTION_INDEX_INVALID) exits 2", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "QUESTION_INDEX_INVALID", "No question 5."),
    });
    const name = await file(ctx, "answers.json", {
      answers: [{ question_index: 5, answer: "Yes." }],
    });
    const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "QUESTION_INDEX_INVALID" },
    });
  });

  it("usage: respond without answers (no -f) exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "intent", "respond", "conv-example-1");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an empty answers list", { answers: [] }, "$.answers"],
    ["no answers field", { delegate: true }, "$.answers"],
    ["an empty answer", { answers: [{ question_index: 0, answer: "" }] }, "$.answers[0].answer"],
    [
      "a negative question index",
      { answers: [{ question_index: -1, answer: "Yes." }] },
      "$.answers[0].question_index",
    ],
  ])(
    "usage: respond with %s exits 2 with INPUT_INVALID and sends nothing",
    async (_, value, path) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "answers.json", value);
      const { code, body } = await run(ctx, "intent", "respond", "conv-example-1", "-f", name);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: {
          code: "INPUT_INVALID",
          details: { method: "POST", path: "/intents/{conversation_id}/respond" },
        },
      });
      const issues = body.error?.details["issues"] as { path: string }[];
      expect(issues.map((issue) => issue.path)).toContain(path);
      expect(calls).toHaveLength(0);
    },
  );

  it("usage: respond without a conversation exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "intent", "respond", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it.each([["  "], ["."], [".."]])(
    "usage: respond to the conversation %j exits 2 and sends nothing",
    async (conversation) => {
      const { ctx, calls } = await setup();
      const name = await file(ctx, "answers.json", ANSWERS);
      const { code, body } = await run(ctx, "intent", "respond", conversation, "-f", name);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
      expect(calls).toHaveLength(0);
    },
  );

  it("usage: respond to two conversations exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "answers.json", ANSWERS);
    const { code, body } = await run(ctx, "intent", "respond", "conv-a", "conv-b", "-f", name);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

/** Pages of `n` requests, answering `GET /intents` with the page the query names. */
function pagedRequests(total: number) {
  const all = Array.from({ length: total }, (_, i) =>
    intakeRequest({ request_id: `conv-example-${i + 1}`, version: i + 1 }),
  );
  return (call: Call): Response => {
    const page = Number(call.url.searchParams.get("page") ?? "1");
    const perPage = Number(call.url.searchParams.get("per_page") ?? "20");
    const rows = all.slice((page - 1) * perPage, page * perPage);
    return jsonResponse(
      200,
      { status: "ok", data: rows, meta: { page, per_page: perPage } },
      { "x-request-id": `req_fake_page_${page}`, "pidgen-api-version": "1.0" },
    );
  };
}

describe("pidgen intent list", () => {
  it("list reads GET /intents and returns every request, leaving the state to the server's default", async () => {
    const requests = [intakeRequest(), intakeRequest({ request_id: "conv-example-2" })];
    const { ctx, calls } = await setup({
      respond: () =>
        jsonResponse(
          200,
          { status: "ok", data: requests, meta: { page: 1, per_page: 100 } },
          { "x-request-id": "req_fake_list", "pidgen-api-version": "1.0" },
        ),
    });
    const { code, body } = await run(ctx, "intent", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: requests,
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      page: "1",
      per_page: "100",
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("list sends --project as project_id and --state as state", async () => {
    const { ctx, calls } = await setup({ respond: pagedRequests(0) });
    const { code, body } = await run(
      ctx,
      "intent",
      "list",
      "--project",
      "ALPHA",
      "--state",
      "withdrawn",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: [] });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      project_id: "ALPHA",
      state: "withdrawn",
      page: "1",
      per_page: "100",
    });
  });

  it.each([["clarifying"], ["created"], ["withdrawn"]])(
    "list --state %s is accepted and sent",
    async (state) => {
      const { ctx, calls } = await setup({ respond: pagedRequests(1) });
      const { code, body } = await run(ctx, "intent", "list", "--state", state);
      expect(code).toBe(ExitCode.Ok);
      expect((body.data as unknown[]).length).toBe(1);
      expect(calls[0]?.url.searchParams.get("state")).toBe(state);
    },
  );

  it("list follows every page to the last", async () => {
    const { ctx, calls } = await setup({ respond: pagedRequests(230) });
    const { code, body } = await run(ctx, "intent", "list");
    expect(code).toBe(ExitCode.Ok);
    const data = body.data as { request_id: string }[];
    expect(data).toHaveLength(230);
    expect(data[0]?.request_id).toBe("conv-example-1");
    expect(data[229]?.request_id).toBe("conv-example-230");
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(body.meta["request_id"]).toBe("req_fake_page_1");
  });

  it("list refused by the server (422 INPUT_INVALID for a state it does not know) exits 2", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "INPUT_INVALID", "state: not a state"),
    });
    const { code, body } = await run(ctx, "intent", "list", "--state", "created");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
  });

  it("list refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not read requests."),
    });
    const { code, body } = await run(ctx, "intent", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it("list against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx, calls } = await setup({
      respond: () => publicError(404, "NOT_FOUND", "No such route."),
    });
    const { code, body } = await run(ctx, "intent", "list");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "NOT_FOUND", details: { status: 404 } },
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["an unknown state", ["intent", "list", "--state", "open"], /--state.*invalid/],
    ["a state in the wrong case", ["intent", "list", "--state", "Clarifying"], /--state.*invalid/],
    [
      "creating, a state the list does not take",
      ["intent", "list", "--state", "creating"],
      /--state.*invalid/,
    ],
    ["an empty state", ["intent", "list", "--state", ""], /--state.*invalid/],
    ["a missing state value", ["intent", "list", "--state"], /argument missing/],
    ["an empty project", ["intent", "list", "--project", ""], /--project/],
    ["a blank project", ["intent", "list", "--project", "  "], /--project/],
    ["a missing project value", ["intent", "list", "--project"], /argument missing/],
    ["an argument", ["intent", "list", "conv-example-1"], /too many arguments/],
    ["an unknown flag", ["intent", "list", "--all"], /unknown option/],
  ])("usage: list with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });

  it("list with no credential exits 3 and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "intent", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen intent show", () => {
  it("show reads GET /intents/{conversation} and returns the request", async () => {
    const request = intakeRequest();
    const { ctx, calls } = await setup({ respond: () => ok(200, request, "req_fake_show") });
    const { code, body } = await run(ctx, "intent", "show", "conv-example-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: request,
      error: null,
      meta: { ...META, request_id: "req_fake_show" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv-example-1");
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("show percent-encodes the conversation as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, intakeRequest()) });
    const { code } = await run(ctx, "intent", "show", "conv/../x");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv%2F..%2Fx");
  });

  it("show of an unknown request (404 CONVERSATION_NOT_FOUND) is not found, exit 4", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "intent", "show", "conv-missing");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "CONVERSATION_NOT_FOUND",
        message: "No such request in the Account.",
        details: { status: 404, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("show against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup({ respond: () => publicError(404, "NOT_FOUND", "No such route.") });
    const { code, body } = await run(ctx, "intent", "show", "conv-example-1");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("show refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not read this request."),
    });
    const { code, body } = await run(ctx, "intent", "show", "conv-example-1");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["no conversation", ["intent", "show"], /missing required argument/],
    ["a blank conversation", ["intent", "show", "  "], /conversation is required/],
    ["a . conversation", ["intent", "show", "."], /Not a valid conversation/],
    ["a .. conversation", ["intent", "show", ".."], /Not a valid conversation/],
    ["two conversations", ["intent", "show", "conv-a", "conv-b"], /too many arguments/],
    [
      "an unknown flag",
      ["intent", "show", "conv-example-1", "--state", "created"],
      /unknown option/,
    ],
  ])("usage: show with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen intent withdraw", () => {
  it("withdraw posts an empty body to POST /intents/{conversation}/withdraw and returns the request", async () => {
    const { ctx, calls } = await setup({
      respond: () => ok(200, WITHDRAWN_REQUEST, "req_fake_withdraw"),
    });
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-example-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: WITHDRAWN_REQUEST,
      error: null,
      meta: { ...META, request_id: "req_fake_withdraw" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv-example-1/withdraw");
    expect(calls[0]?.body).toEqual({});
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("withdraw --reason sends the reason", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, WITHDRAWN_REQUEST) });
    const { code } = await run(
      ctx,
      "intent",
      "withdraw",
      "conv-example-1",
      "--reason",
      "Duplicate of ALPHA-3.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ reason: "Duplicate of ALPHA-3." });
  });

  it("withdraw percent-encodes the conversation as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, WITHDRAWN_REQUEST) });
    const { code } = await run(ctx, "intent", "withdraw", "conv/../x");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.pathname).toBe("/api/v1/intents/conv%2F..%2Fx/withdraw");
  });

  it("withdraw refused as not allowed (403 REQUEST_WITHDRAW_FORBIDDEN) is a refusal, exit 5", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        publicError(403, "REQUEST_WITHDRAW_FORBIDDEN", "You may not withdraw this request."),
    });
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-example-1");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "REQUEST_WITHDRAW_FORBIDDEN",
        message: "You may not withdraw this request.",
        details: { status: 403, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("withdraw of a request that already became a ticket (409 REQUEST_ALREADY_CREATED) exits 5 and names the ticket", async () => {
    const { ctx } = await setup({
      respond: () =>
        publicError(409, "REQUEST_ALREADY_CREATED", "The request already became a ticket.", {
          ticket_id: "TKT-example-7",
          ticket_key: "ALPHA-7",
        }),
    });
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-example-1");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "REQUEST_ALREADY_CREATED",
        message: "The request already became a ticket.",
        details: {
          status: 409,
          request_id: "req_fake_error",
          ticket_id: "TKT-example-7",
          ticket_key: "ALPHA-7",
        },
      },
    });
  });

  it("withdraw of an unknown request (404 CONVERSATION_NOT_FOUND) is not found, exit 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-missing");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CONVERSATION_NOT_FOUND" },
    });
  });

  it("withdraw against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup({ respond: () => publicError(404, "NOT_FOUND", "No such route.") });
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-example-1");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("a plain 403 FORBIDDEN on withdraw is still an authorization failure, exit 3", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not change requests."),
    });
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-example-1");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["no conversation", ["intent", "withdraw"], /missing required argument/],
    ["a blank conversation", ["intent", "withdraw", "  "], /conversation is required/],
    ["a . conversation", ["intent", "withdraw", "."], /Not a valid conversation/],
    ["a .. conversation", ["intent", "withdraw", ".."], /Not a valid conversation/],
    ["two conversations", ["intent", "withdraw", "conv-a", "conv-b"], /too many arguments/],
    ["an empty reason", ["intent", "withdraw", "conv-example-1", "--reason", ""], /--reason/],
    ["a blank reason", ["intent", "withdraw", "conv-example-1", "--reason", "   "], /--reason/],
    [
      "a missing reason value",
      ["intent", "withdraw", "conv-example-1", "--reason"],
      /argument missing/,
    ],
    ["an unknown flag", ["intent", "withdraw", "conv-example-1", "--force"], /unknown option/],
  ])("usage: withdraw with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [intent, list] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({
      respond: () => ok(200, [WITHDRAWN_REQUEST], "req_example"),
    });
    ctx.io.stdoutColumns = columns;
    const argv = ["intent", "list"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Intents (1 displayed)", WITHDRAWN_REQUEST.request_id, "withdrawn"])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);

// Resource fixture coverage and read-operation compatibility.
it.each([40, 80, 120])(
  "resource fixture presentation: [intent, show, conv-example-1] at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({
      respond: () => ok(200, WITHDRAWN_REQUEST, "req_example"),
    });
    ctx.io.stdoutColumns = columns;
    const argv = ["intent", "show", "conv-example-1"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    for (const value of ["Intent", "Questions", "Withdrawn", "Duplicate of ALPHA-3."])
      expect(ctx.out.join("")).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
  },
);

it.each([40, 80, 120])(
  "intent clarification retains questions and the conversation at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({ respond: () => ok(200, CLARIFICATION) });
    ctx.io.stdoutColumns = columns;
    const name = await file(ctx, "intent.json", INTENT);
    const json = await expectMutationParity(
      ctx,
      calls,
      ["intent", "submit", "-f", name],
      ["Needs clarification.", "conv-example-1", "Questions"],
    );
    expect(json.data).toEqual(CLARIFICATION);
    expect(calls).toHaveLength(1);
  },
);
