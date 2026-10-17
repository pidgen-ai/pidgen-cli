import { expectMutationParity } from "../support/context.js";
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

const REPORT = {
  id: "fbk-example-1",
  reference: "3f9a1c07",
  kind: "not_working",
  created_at: "2026-10-11T09:30:00Z",
};

/** The context every feedback carries: where it was sent from. */
const CONTEXT = {
  source: "cli",
  cli_version: "0.0.0-test",
  os: process.platform,
  arch: process.arch,
  node_version: process.versions.node,
  api_base: SERVER,
};

const META = {
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

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

/** Records the report for `POST /feedback`, echoing the kind it was sent. */
function server(call: Call): Response {
  if (call.url.pathname === "/api/v1/feedback" && call.method === "POST") {
    const kind = (call.body as { kind?: string } | undefined)?.kind ?? "other";
    return ok(201, { ...REPORT, kind }, "req_fake_feedback");
  }
  return publicError(404, "NOT_FOUND", "No such route.");
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

async function file(ctx: TestContext, name: string, content: string): Promise<string> {
  await writeFile(join(ctx.cwd, name), content);
  return name;
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

describe("pidgen feedback sends", () => {
  it("sends --kind not-working and the message to POST /feedback and prints the server's report", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "feedback", "--kind", "not-working", "It crashed.");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: REPORT,
      error: null,
      meta: { ...META, request_id: "req_fake_feedback" },
    });
    expect((body.data as typeof REPORT).reference).toBe("3f9a1c07");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api/v1/feedback");
    expect(calls[0]?.body).toEqual({
      kind: "not_working",
      message: "It crashed.",
      contact_ok: true,
      context: CONTEXT,
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("sends the context of the profile's server as api_base", async () => {
    const other = "https://pidgen.other.example.com";
    const { ctx, calls } = await setup({
      config: { ...CONFIG, profiles: { default: { ...CONFIG.profiles["default"]!, url: other } } },
    });
    const { code } = await run(ctx, "feedback", "--kind", "other", "Hello.");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.origin).toBe(other);
    expect((calls[0]?.body as { context: unknown }).context).toEqual({
      ...CONTEXT,
      api_base: other,
    });
  });

  it("with nothing configured, sends nothing and exits 3 with AUTH_REQUIRED", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "feedback", "--kind", "other", "Hello.");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen feedback options", () => {
  it.each([
    ["not-working", "not_working"],
    ["improvement", "improvement"],
    ["other", "other"],
  ])("--kind %s is sent as kind %s", async (given, sent) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "feedback", "--kind", given, "A message.");
    expect(code).toBe(ExitCode.Ok);
    expect((calls[0]?.body as { kind: string }).kind).toBe(sent);
    expect((body.data as { kind: string }).kind).toBe(sent);
  });

  it.each([
    ["an unknown kind", ["feedback", "--kind", "bug", "A message."], /--kind.*invalid/],
    ["the API spelling", ["feedback", "--kind", "not_working", "A message."], /--kind.*invalid/],
    ["no --kind", ["feedback", "A message."], /--kind/],
    ["a missing --kind value", ["feedback", "A message.", "--kind"], /argument missing/],
    ["no message", ["feedback", "--kind", "other"], /message/],
    [
      "both a message and --message-file",
      ["feedback", "--kind", "other", "A message.", "--message-file", "m.txt"],
      /--message-file/,
    ],
    ["two messages", ["feedback", "--kind", "other", "One.", "Two."], /too many arguments/],
    ["an unknown flag", ["feedback", "--kind", "other", "A message.", "--loud"], /unknown option/],
  ])("usage: %s exits 2 and sends nothing", async (_, argv, message) => {
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

  it("--message-file reads the message from a file, without its final newline", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "feedback.txt", "Line one.\nLine two.\n");
    const { code } = await run(ctx, "feedback", "--kind", "improvement", "--message-file", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      kind: "improvement",
      message: "Line one.\nLine two.",
      contact_ok: true,
      context: CONTEXT,
    });
  });

  it("--message-file - reads the message from standard input", async () => {
    const { ctx, calls } = await setup();
    ctx.readStdin = () => Promise.resolve("From standard input.\n");
    const { code } = await run(ctx, "feedback", "--kind", "other", "--message-file", "-");
    expect(code).toBe(ExitCode.Ok);
    expect((calls[0]?.body as { message: string }).message).toBe("From standard input.");
  });

  it("--message-file naming a missing file exits 2 with INPUT_INVALID and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "feedback",
      "--kind",
      "other",
      "--message-file",
      "missing.txt",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID", details: { source: "missing.txt" } },
    });
    expect(calls).toHaveLength(0);
  });

  it("--no-contact sends contact_ok false", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "feedback", "--kind", "other", "--no-contact", "A message.");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      kind: "other",
      message: "A message.",
      contact_ok: false,
      context: CONTEXT,
    });
  });

  it("the help names every kind and option", async () => {
    const ctx = await testContext();
    expect(await runCli(["feedback", "--help"], ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    for (const word of ["not-working", "improvement", "other", "--message-file", "--no-contact"]) {
      expect(help).toContain(word);
    }
    expect(help).toMatch(/--after <command> <exit>/);
  });
});

describe("pidgen feedback --after", () => {
  it("--after <command> <exit> before the message adds last_command and exit_code", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(
      ctx,
      "feedback",
      "--kind",
      "not-working",
      "--after",
      "pidgen ticket show PIDGEN-12",
      "4",
      "It said not found.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      kind: "not_working",
      message: "It said not found.",
      contact_ok: true,
      context: { ...CONTEXT, last_command: "pidgen ticket show PIDGEN-12", exit_code: 4 },
    });
  });

  it("--after after the message, with --message-file, adds the same two keys", async () => {
    const { ctx, calls } = await setup();
    const name = await file(ctx, "m.txt", "It hung.");
    const { code } = await run(
      ctx,
      "feedback",
      "--kind",
      "other",
      "--message-file",
      name,
      "--after",
      "pidgen worker start",
      "0",
    );
    expect(code).toBe(ExitCode.Ok);
    expect((calls[0]?.body as { context: unknown }).context).toEqual({
      ...CONTEXT,
      last_command: "pidgen worker start",
      exit_code: 0,
    });
  });

  it("without --after neither last_command nor exit_code is sent", async () => {
    const { ctx, calls } = await setup();
    await run(ctx, "feedback", "--kind", "other", "A message.");
    const context = (calls[0]?.body as { context: Record<string, unknown> }).context;
    expect(context).toEqual(CONTEXT);
    expect(context).not.toHaveProperty("last_command");
    expect(context).not.toHaveProperty("exit_code");
  });

  it.each([
    ["only a command", ["--after", "pidgen ticket show"], /--after/],
    ["an exit that is not a number", ["--after", "pidgen ticket show", "four", "M."], /--after/],
    ["a fractional exit", ["--after", "pidgen ticket show", "1.5", "M."], /--after/],
    ["an empty command", ["--after", " ", "1", "M."], /--after/],
    ["a missing value", ["M.", "--after"], /argument missing/],
    ["two messages after it", ["--after", "pidgen x", "1", "One.", "Two."], /too many/],
  ])("usage: --after with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "feedback", "--kind", "other", ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen feedback refusal", () => {
  it.each([
    [429, "FEEDBACK_RATE_LIMITED", "Too much feedback from you recently; try again later."],
    [422, "FEEDBACK_MESSAGE_TOO_LONG", "The message is longer than the server accepts."],
  ])(
    "a refusal (%s %s) keeps its code and exits with the refusal code 5",
    async (status, serverCode, message) => {
      const { ctx, calls } = await setup({
        respond: () => publicError(status, serverCode, message),
      });
      const { code, body } = await run(ctx, "feedback", "--kind", "other", "A message.");
      expect(code).toBe(ExitCode.Refused);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: {
          code: serverCode,
          message,
          details: { status, request_id: "req_fake_error" },
        },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("another refusal keeps the status's exit code (403 FORBIDDEN exits 3)", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "The token may not send feedback."),
    });
    const { code, body } = await run(ctx, "feedback", "--kind", "other", "A message.");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["a message over 4000 characters", "m".repeat(4001)],
    ["an empty message", ""],
  ])(
    "the body is validated against the contract first: %s exits 2 with INPUT_INVALID and sends nothing",
    async (_, message) => {
      const { ctx, calls } = await setup();
      const { code, body } = await run(ctx, "feedback", "--kind", "other", message);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: { code: "INPUT_INVALID", details: { method: "POST", path: "/feedback" } },
      });
      const issues = body.error?.details["issues"] as { path: string }[];
      expect(issues.map((issue) => issue.path)).toContain("$.message");
      expect(calls).toHaveLength(0);
    },
  );

  it("a message of exactly 4000 characters is sent", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, "feedback", "--kind", "other", "m".repeat(4000));
    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
  });
});

it.each([40, 80, 120])(
  "feedback identity preserves the direct send at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const json = await expectMutationParity(
      ctx,
      calls,
      ["feedback", "--kind", "not-working", "It crashed."],
      ["feedback", REPORT.reference, REPORT.id],
    );
    expect(json.data).toEqual(REPORT);
    expect(calls).toHaveLength(1);
  },
);
