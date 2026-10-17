import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { useMockServer } from "../support/mock-server.js";

// The intent commands against Prism mocking the committed contracts/openapi.json: Prism refuses a
// request whose body does not match the document, so a success here means the CLI sent a body the
// document accepts.

const server = useMockServer();

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

async function setup() {
  const sent: Sent[] = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_pat_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      const text = init?.body;
      sent.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
      });
      return globalThis.fetch(input, init);
    },
  });
  return { ctx, sent };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("intent commands against the Prism mock of the committed document", () => {
  it("pidgen intent submit sends the file's body and returns a documented outcome", async () => {
    const { ctx, sent } = await setup();
    const intent = [
      "title: Show the login page",
      "objective: People can sign in from the home page.",
      "project_id: ALPHA",
      "",
    ].join("\n");
    await writeFile(join(ctx.cwd, "intent.yaml"), intent);
    const { code, body } = await run(ctx, "intent", "submit", "-f", "intent.yaml");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(body.data).toEqual(
      expect.objectContaining({
        outcome: expect.stringMatching(/^(created|needs_clarification)$/),
      }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/intents`],
    ]);
  });

  it("pidgen intent respond sends the answers and returns a documented outcome", async () => {
    const { ctx, sent } = await setup();
    const answers = { answers: [{ question_index: 0, answer: "Email and password." }] };
    await writeFile(join(ctx.cwd, "answers.json"), JSON.stringify(answers));
    const { code, body } = await run(
      ctx,
      "intent",
      "respond",
      "conv-example-1",
      "-f",
      "answers.json",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({
        outcome: expect.stringMatching(/^(created|still_needs_clarification)$/),
      }),
    );
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/intents/conv-example-1/respond`],
    ]);
    expect(sent[0]?.body).toEqual(answers);
  });
});

describe("the durable intake request commands against the Prism mock of the committed document", () => {
  const REQUEST_FIELDS = [
    "request_id",
    "state",
    "questions",
    "question_count",
    "answered_count",
    "assumption_count",
    "actions",
    "addressed_to",
    "waiting_since",
    "version",
  ];

  it("pidgen intent submit --submission-key sends submission_key in a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    const intent = { title: "Show the login page", objective: "Sign in.", project_id: "ALPHA" };
    await writeFile(join(ctx.cwd, "intent.json"), JSON.stringify(intent));
    const { code, body } = await run(
      ctx,
      "intent",
      "submit",
      "-f",
      "intent.json",
      "--submission-key",
      "key-example-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.data).toEqual(
      expect.objectContaining({
        outcome: expect.stringMatching(/^(created|needs_clarification)$/),
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ ...intent, submission_key: "key-example-1" });
  });

  it("pidgen intent respond sends question_id answers with outcomes, which the document accepts", async () => {
    const { ctx, sent } = await setup();
    const answers = {
      answers: [
        { question_id: "q-example-1", outcome: "use_recommendation" },
        { question_id: "q-example-2", answer: "Yes, for 30 days." },
        { question_id: "q-example-3", outcome: "ask_teammate", ask_user_id: "usr-example-2" },
        { question_id: "q-example-4", outcome: "leave_open" },
      ],
    };
    await writeFile(join(ctx.cwd, "answers.json"), JSON.stringify(answers));
    const { code, body } = await run(
      ctx,
      "intent",
      "respond",
      "conv-example-1",
      "-f",
      "answers.json",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/intents/conv-example-1/respond`],
    ]);
    expect(sent[0]?.body).toEqual(answers);
  });

  it("pidgen intent respond sends empty answers with delegate, which the document accepts", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "answers.json"), JSON.stringify({ answers: [], delegate: true }));
    const { code, body } = await run(
      ctx,
      "intent",
      "respond",
      "conv-example-1",
      "-f",
      "answers.json",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent[0]?.body).toEqual({ answers: [], delegate: true });
  });

  it("the document itself refuses an unknown outcome, and leaves empty or incomplete answers to the server", async () => {
    // Prism applies the committed schemas to a raw request, apart from the CLI's own checks.
    const post = async (body: unknown) =>
      (
        await globalThis.fetch(`${server().url}/api/v1/intents/conv-example-1/respond`, {
          method: "POST",
          headers: {
            authorization: "Bearer pidgen_pat_fake_contract_token",
            "x-pidgen-account": "ACC-EXAMPLE",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).status;
    expect(await post({ answers: [], delegate: true })).toBe(200);
    expect(await post({ answers: [{ question_id: "q1", outcome: "leave_open" }] })).toBe(200);
    expect(await post({ answers: [{ question_id: "q1", answer: "Yes." }] })).toBe(200);
    // The published schema leaves these to the server (ANSWER_EMPTY, QUESTION_NOT_FOUND); the CLI
    // refuses them before sending (tests/commands/intent.test.ts), so the mock accepts them raw.
    expect(await post({ answers: [] })).toBe(200);
    expect(await post({ answers: [{ question_id: "q1" }] })).toBe(200);
    expect(await post({ answers: [{ answer: "Yes." }] })).toBe(200);
    expect(await post({ answers: [{ question_id: "q1", outcome: "skip" }] })).toBe(422);
  });

  it("pidgen intent list reads GET /intents with the documented query and returns requests", async () => {
    const { ctx, sent } = await setup();
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
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(Array.isArray(body.data)).toBe(true);
    for (const request of body.data as Record<string, unknown>[]) {
      for (const field of REQUEST_FIELDS) expect(request).toHaveProperty(field);
    }
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      [
        "GET",
        `${server().url}/api/v1/intents?project_id=ALPHA&state=withdrawn&page=1&per_page=100`,
      ],
    ]);
  });

  it("pidgen intent list without --state sends none, and the document defaults it to clarifying", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "intent", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent.map((call) => call.url)).toEqual([
      `${server().url}/api/v1/intents?page=1&per_page=100`,
    ]);
  });

  it("the document refuses an unknown list state, as the CLI does before sending", async () => {
    const response = await globalThis.fetch(`${server().url}/api/v1/intents?state=open`, {
      headers: {
        authorization: "Bearer pidgen_pat_fake_contract_token",
        "x-pidgen-account": "ACC-EXAMPLE",
      },
    });
    expect(response.status).toBe(422);
  });

  it("pidgen intent show reads GET /intents/{conversation} and returns the request", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "intent", "show", "conv-example-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    for (const field of REQUEST_FIELDS) expect(body.data).toHaveProperty(field);
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/intents/conv-example-1`],
    ]);
  });

  it("pidgen intent withdraw posts the reason to POST /intents/{conversation}/withdraw", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "intent",
      "withdraw",
      "conv-example-1",
      "--reason",
      "Duplicate of ALPHA-3.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    for (const field of REQUEST_FIELDS) expect(body.data).toHaveProperty(field);
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/intents/conv-example-1/withdraw`],
    ]);
    expect(sent[0]?.body).toEqual({ reason: "Duplicate of ALPHA-3." });
  });

  it("pidgen intent withdraw without a reason posts an empty body the document accepts", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "intent", "withdraw", "conv-example-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(sent[0]?.body).toEqual({});
  });

  it("pidgen review attention prints the requests and request_counts the document gives, unchanged", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty("findings");
    const requests = data["requests"] as Record<string, unknown>[];
    expect(requests.length).toBeGreaterThan(0);
    for (const entry of requests) {
      expect(Object.keys(entry).sort()).toEqual(["decision_key", "request"]);
      for (const field of REQUEST_FIELDS) expect(entry["request"]).toHaveProperty(field);
    }
    expect(data["request_counts"]).toEqual({
      me: expect.any(Number),
      all: expect.any(Number),
      items: expect.any(Number),
    });
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/attention`],
    ]);
  });
});
