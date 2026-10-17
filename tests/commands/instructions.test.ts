import { expectMutationParity } from "../support/context.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import type { RunContext } from "../../src/core/context.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import { INSTRUCTION_MODES, INSTRUCTION_STATES } from "../../src/core/instructions.js";
import {
  acceptedInstruction,
  deliveredInstruction,
  dispatchedInstruction,
  instruction,
  returnedInstruction,
} from "../support/instructions.js";

// The steering instruction commands (pidgen session steer | instructions | edit-instruction |
// withdraw-instruction, pidgen ticket instructions) against a fake of the published contract: no
// real server is contacted.

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const SESSION = "ses-example-1";
const SESSION_PATH = `/api/v1/sessions/${SESSION}/instructions`;

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
  /** A multipart body (a staged upload), when the request sent one. */
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
  api_version: "1.0",
  profile: "default",
  account: "ACC-EXAMPLE",
  cli_version: "0.0.0-test",
};

const QUEUED = instruction();
const DELIVERED = deliveredInstruction();
const DISPATCHED = dispatchedInstruction();
const ACCEPTED = acceptedInstruction({ instruction_id: "ins-example-3", mode: "queue" });
const RETURNED = returnedInstruction({ instruction_id: "ins-example-4" });

/** A command's help, as one line of words. */
async function help(...argv: string[]): Promise<string> {
  const { ctx } = await setup();
  ctx.out.length = 0;
  expect(await runCli([...argv, "--help"], ctx)).toBe(ExitCode.Ok);
  return ctx.out.join("").replace(/\s+/g, " ");
}

describe("the instruction states and modes (ADR-142 §2, §3)", () => {
  it("lists every state the contract publishes, the live path's dispatched and accepted among them", () => {
    expect(INSTRUCTION_STATES).toEqual([
      "queued",
      "dispatched",
      "accepted",
      "delivered",
      "acknowledged",
      "unapplied",
      "withdrawn",
    ]);
  });

  it("lists the modes accepted in this release, steer and queue, and not the reserved interrupt", () => {
    expect(INSTRUCTION_MODES).toEqual(["steer", "queue"]);
  });
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

async function setup(
  options: {
    respond?: (call: Call) => Response;
    config?: Config | null;
    context?: Partial<RunContext>;
  } = {},
) {
  const calls: Call[] = [];
  const respond = options.respond ?? (() => publicError(404, "NOT_FOUND", "No such route."));
  const ctx = await testContext({
    fetch: (input, init) => {
      const text = init?.body;
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
        ...(text instanceof FormData ? { form: text } : {}),
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
    ...options.context,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("pidgen session steer", () => {
  it("steer --text sends the text with one idempotency key to POST /sessions/{session}/instructions and prints the queued instruction", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED, "req_fake_steer") });
    const { code, body } = await run(
      ctx,
      "session",
      "steer",
      SESSION,
      "--text",
      "Prefer the existing retry helper.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: QUEUED,
      error: null,
      meta: { ...META, request_id: "req_fake_steer" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(SESSION_PATH);
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.body).toEqual({
      text: "Prefer the existing retry helper.",
      idempotency_key: expect.stringMatching(UUID),
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("steer prints an instruction the server dispatched to the running session unchanged, with its mode", async () => {
    const { ctx } = await setup({ respond: () => ok(201, DISPATCHED, "req_fake_steer") });
    const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Hi.");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: DISPATCHED, error: null });
    expect(body.data).toMatchObject({ state: "dispatched", mode: "steer", return_code: null });
  });

  it("steer --format table shows the instruction's state and mode", async () => {
    const { ctx } = await setup({ respond: () => ok(201, DISPATCHED) });
    ctx.out.length = 0;
    const code = await runCli(
      ["--format", "table", "session", "steer", SESSION, "--text", "Hi."],
      ctx,
    );
    expect(code).toBe(ExitCode.Ok);
    const table = ctx.out.join("");
    expect(table).toMatch(/^State: dispatched$/m);
    expect(table).toMatch(/^Mode: steer$/m);
    expect(table).toMatch(/^Dispatched at: 2026-10-05T09:00:02Z$/m);
  });

  it("steer's help describes live delivery: the running session, dispatched and accepted, the modes and a returned instruction's code", async () => {
    const text = await help("session", "steer");
    expect(text).toMatch(/running session/);
    expect(text).toMatch(/\bdispatched\b/);
    expect(text).toMatch(/\baccepted\b/);
    expect(text).toMatch(/\backnowledged\b/);
    expect(text).toMatch(/\bmode\b/);
    expect(text).toMatch(/\bsteer\b.*\bqueue\b/);
    expect(text).toMatch(/return_code/);
    expect(text).toMatch(/next attempt/);
    // The summary no longer promises only the next prompt.
    expect(text).not.toMatch(/with an instruction for its next prompt/);
  });

  it("steer generates a new idempotency key for each command", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    await run(ctx, "session", "steer", SESSION, "--text", "One.");
    await run(ctx, "session", "steer", SESSION, "--text", "One.");
    const keys = calls.map((call) => (call.body as { idempotency_key: string }).idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("steer retries a lost response with the same idempotency key, so the instruction is queued once", async () => {
    let attempt = 0;
    const { ctx, calls } = await setup({
      respond: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return ok(201, QUEUED, "req_fake_retry");
      },
    });
    const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Retry me.");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: QUEUED, meta: { request_id: "req_fake_retry" } });
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((call) => call.body as Record<string, unknown>);
    expect(first?.["idempotency_key"]).toMatch(UUID);
    expect(second).toEqual(first);
  });

  it("steer -f sends the file's text without its trailing newline", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    const name = await file(ctx, "steer.txt", "Use the retry helper.\nKeep the change small.\n");
    const { code } = await run(ctx, "session", "steer", SESSION, "-f", name);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      text: "Use the retry helper.\nKeep the change small.",
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("steer -f - reads the text from standard input", async () => {
    const { ctx, calls } = await setup({
      respond: () => ok(201, QUEUED),
      context: { readStdin: () => Promise.resolve("From standard input.\n") },
    });
    const { code } = await run(ctx, "session", "steer", SESSION, "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({ text: "From standard input." });
  });

  it("steer --text sends the text with its surrounding whitespace removed", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    await run(ctx, "session", "steer", SESSION, "--text", "  Spaced.  ");
    expect(calls[0]?.body).toMatchObject({ text: "Spaced." });
  });

  it("steer accepts text of exactly 8000 characters", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    const text = "x".repeat(8000);
    const { code } = await run(ctx, "session", "steer", SESSION, "--text", text);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({ text });
  });

  it("steer percent-encodes the session as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    const { code } = await run(ctx, "session", "steer", "ses/../x", "--text", "Hello.");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.pathname).toBe("/api/v1/sessions/ses%2F..%2Fx/instructions");
  });

  it.each([
    ["STEP_SETTLED", "The step already finished."],
    ["RUN_PAUSED", "The run is paused."],
    ["RUN_HELD", "The run is held."],
    ["RUN_TERMINAL", "The run has ended."],
    ["STEER_TARGET_NOT_PROMPT", "The step does not take a prompt."],
  ])(
    "steer refused by the server (409 %s) is a refusal, exit 5, with its code",
    async (code, message) => {
      const { ctx, calls } = await setup({ respond: () => publicError(409, code, message) });
      const result = await run(ctx, "session", "steer", SESSION, "--text", "Too late.");
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body).toMatchObject({
        ok: false,
        data: null,
        error: { code, message, details: { status: 409, request_id: "req_fake_error" } },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("steer of an unknown session (404 SESSION_NOT_FOUND) is not found, exit 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "SESSION_NOT_FOUND", "No such session in the Account."),
    });
    const { code, body } = await run(ctx, "session", "steer", "ses-missing", "--text", "Hi.");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "SESSION_NOT_FOUND" } });
  });

  it.each([["STEER_EMPTY"], ["STEER_TOO_LONG"], ["ARTIFACT_REFERENCE_UNAVAILABLE"]])(
    "steer refused by the server (422 %s) exits 2 with its code",
    async (serverCode) => {
      const { ctx } = await setup({ respond: () => publicError(422, serverCode, "Refused.") });
      const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Hi.");
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: serverCode } });
    },
  );

  it("steer refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not steer this session."),
    });
    const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Hi.");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it("steer against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup({ respond: () => publicError(404, "NOT_FOUND", "No such route.") });
    const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Hi.");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("steer with nothing configured exits 3 with AUTH_REQUIRED and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Hi.");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no session", ["session", "steer", "--text", "Hi."], /missing required argument/],
    ["a blank session", ["session", "steer", "  ", "--text", "Hi."], /session is required/],
    ["a . session", ["session", "steer", ".", "--text", "Hi."], /Not a valid session/],
    ["a .. session", ["session", "steer", "..", "--text", "Hi."], /Not a valid session/],
    ["two sessions", ["session", "steer", "ses-a", "ses-b", "--text", "Hi."], /too many arguments/],
    ["neither --text nor -f", ["session", "steer", SESSION], /--text <text> or -f <file>/],
    [
      "both --text and -f",
      ["session", "steer", SESSION, "--text", "Hi.", "-f", "steer.txt"],
      /mutually exclusive/,
    ],
    ["an empty --text", ["session", "steer", SESSION, "--text", ""], /empty/],
    ["a blank --text", ["session", "steer", SESSION, "--text", "   \n"], /empty/],
    [
      "a --text over 8000 characters",
      ["session", "steer", SESSION, "--text", "x".repeat(8001)],
      /8000/,
    ],
    ["a missing --text value", ["session", "steer", SESSION, "--text"], /argument missing/],
    ["an empty file", ["session", "steer", SESSION, "-f", "empty.txt"], /empty/],
    [
      "a missing file",
      ["session", "steer", SESSION, "-f", "missing.txt"],
      /Cannot read input file/,
    ],
    [
      "an unknown flag",
      ["session", "steer", SESSION, "--text", "Hi.", "--force"],
      /unknown option/,
    ],
  ])("usage: steer with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    await file(ctx, "steer.txt", "From a file.");
    await file(ctx, "empty.txt", "\n");
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { message: expect.stringMatching(message) },
    });
    expect(["CLI_USAGE", "INPUT_INVALID"]).toContain(body.error?.code);
    expect(calls).toHaveLength(0);
  });
});

// The composer flags (ADR-142 §9, release N+1): the mode, attachments and quote provenance.
describe("pidgen session steer: --queue, --attach, --quote-message and --quote-file", () => {
  const SNAPSHOT = "7a3c91e";
  const SOURCE = "def retain(days):\n    keep = days\n    return keep\n";

  function sha256(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  }

  async function source(ctx: TestContext): Promise<void> {
    await mkdir(join(ctx.cwd, "src", "export"), { recursive: true });
    await writeFile(join(ctx.cwd, "src", "export", "retention.py"), SOURCE);
  }

  it("--queue sends mode queue", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    const { code, body } = await run(
      ctx,
      "session",
      "steer",
      SESSION,
      "--text",
      "When you finish, update the guide.",
      "--queue",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: QUEUED, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      text: "When you finish, update the guide.",
      mode: "queue",
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("without --queue the request leaves the mode to the server's default, steer", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    await run(ctx, "session", "steer", SESSION, "--text", "Now.");
    expect(calls[0]?.body).not.toHaveProperty("mode");
  });

  it("--attach sends each artifact as an artifact reference, in the order given", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    const { code } = await run(
      ctx,
      "session",
      "steer",
      SESSION,
      "--text",
      "Use these.",
      "--attach",
      "art-example-1",
      "--attach",
      "art-example-2",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      text: "Use these.",
      artifact_refs: [{ artifact_id: "art-example-1" }, { artifact_id: "art-example-2" }],
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("--quote-message sends each message as source_message_ids", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    const { code } = await run(
      ctx,
      "session",
      "steer",
      SESSION,
      "--text",
      "> Keep the old flag.\n\nDo as quoted.",
      "--quote-message",
      "msg-example-1",
      "--quote-message",
      "msg-example-2",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      text: "> Keep the old flag.\n\nDo as quoted.",
      source_message_ids: ["msg-example-1", "msg-example-2"],
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("--quote-file PATH:START-END@SNAPSHOT sends a snapshot file-line quote with the digest of the quoted lines", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    await source(ctx);
    const { code } = await run(
      ctx,
      "session",
      "steer",
      SESSION,
      "--text",
      "Keep is redundant here.",
      "--quote-file",
      `src/export/retention.py:2-3@${SNAPSHOT}`,
      "--quote-file",
      `src/export/retention.py:1-1@${SNAPSHOT}`,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      text: "Keep is redundant here.",
      quoted_file_refs: [
        {
          path: "src/export/retention.py",
          side: "new",
          start_line: 2,
          end_line: 3,
          source: "snapshot",
          snapshot_commit_sha: SNAPSHOT,
          digest: sha256("    keep = days\n    return keep"),
        },
        {
          path: "src/export/retention.py",
          side: "new",
          start_line: 1,
          end_line: 1,
          source: "snapshot",
          snapshot_commit_sha: SNAPSHOT,
          digest: sha256("def retain(days):"),
        },
      ],
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("every flag together: one steer carrying the mode, references and quotes", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    await source(ctx);
    const { code } = await run(
      ctx,
      "session",
      "steer",
      SESSION,
      "--text",
      "All of it.",
      "--queue",
      "--attach",
      "art-example-1",
      "--quote-message",
      "msg-example-1",
      "--quote-file",
      `src/export/retention.py:1-2@${SNAPSHOT}`,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => call.url.pathname)).toEqual([SESSION_PATH]);
    expect(calls[0]?.body).toEqual({
      text: "All of it.",
      mode: "queue",
      artifact_refs: [{ artifact_id: "art-example-1" }],
      source_message_ids: ["msg-example-1"],
      quoted_file_refs: [
        {
          path: "src/export/retention.py",
          side: "new",
          start_line: 1,
          end_line: 2,
          source: "snapshot",
          snapshot_commit_sha: SNAPSHOT,
          digest: sha256("def retain(days):\n    keep = days"),
        },
      ],
      idempotency_key: expect.stringMatching(UUID),
    });
  });

  it("steer's help names the composer flags", async () => {
    const text = await help("session", "steer");
    for (const flag of ["--queue", "--attach", "--quote-message", "--quote-file"]) {
      expect(text).toContain(flag);
    }
    // Staging a local file is planned: the public API publishes no upload route yet.
    expect(text).not.toContain("--upload");
    expect(text).toMatch(/PATH:START-END@SNAPSHOT/);
  });

  it.each([
    ["an empty --attach", ["--attach", " "], /--attach needs an artifact id/],
    ["an empty --quote-message", ["--quote-message", ""], /--quote-message needs a message id/],
    [
      "eleven attachments",
      Array.from({ length: 11 }, (_, i) => ["--attach", `art-example-${i}`]).flat(),
      /10/,
    ],
    [
      "a --quote-file with no lines",
      ["--quote-file", `src/export/retention.py@${SNAPSHOT}`],
      /PATH:START-END@SNAPSHOT/,
    ],
    [
      "a --quote-file with no snapshot",
      ["--quote-file", "src/export/retention.py:1-2"],
      /PATH:START-END@SNAPSHOT/,
    ],
    [
      "a --quote-file with one line number",
      ["--quote-file", `src/export/retention.py:2@${SNAPSHOT}`],
      /PATH:START-END@SNAPSHOT/,
    ],
    [
      "a --quote-file starting at line 0",
      ["--quote-file", `src/export/retention.py:0-2@${SNAPSHOT}`],
      /line 1/,
    ],
    [
      "a --quote-file ending before it starts",
      ["--quote-file", `src/export/retention.py:3-2@${SNAPSHOT}`],
      /before/,
    ],
    [
      "a --quote-file past the file's end",
      ["--quote-file", `src/export/retention.py:2-9@${SNAPSHOT}`],
      /3 lines/,
    ],
    [
      "a --quote-file of a missing file",
      ["--quote-file", `src/missing.py:1-1@${SNAPSHOT}`],
      /Cannot read/,
    ],
    [
      "a --quote-file whose snapshot is not a commit",
      ["--quote-file", `src/export/retention.py:1-1@main`],
      /commit/,
    ],
  ])("usage: steer with %s exits 2 and sends nothing", async (_, extra, message) => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    await source(ctx);
    await file(ctx, "notes.txt", "A file.");
    const { code, body } = await run(ctx, "session", "steer", SESSION, "--text", "Hi.", ...extra);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { message: expect.stringMatching(message) },
    });
    expect(["CLI_USAGE", "INPUT_INVALID"]).toContain(body.error?.code);
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen session instructions", () => {
  const LIST = [DELIVERED, QUEUED];

  it("instructions reads GET /sessions/{session}/instructions and returns the list unchanged, in the server's order", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, LIST, "req_fake_list") });
    const { code, body } = await run(ctx, "session", "instructions", SESSION);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: LIST,
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe(SESSION_PATH);
    expect(calls[0]?.url.search).toBe("");
  });

  it("instructions of a session with none returns an empty list", async () => {
    const { ctx } = await setup({ respond: () => ok(200, []) });
    const { code, body } = await run(ctx, "session", "instructions", SESSION);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: [] });
  });

  it("instructions percent-encodes the session as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, []) });
    await run(ctx, "session", "instructions", "ses/../x");
    expect(calls[0]?.url.pathname).toBe("/api/v1/sessions/ses%2F..%2Fx/instructions");
  });

  it("instructions of an unknown session (404 SESSION_NOT_FOUND) is not found, exit 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "SESSION_NOT_FOUND", "No such session in the Account."),
    });
    const { code, body } = await run(ctx, "session", "instructions", "ses-missing");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "SESSION_NOT_FOUND" } });
  });

  it("instructions against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "session", "instructions", SESSION);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("instructions refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({ respond: () => publicError(403, "FORBIDDEN", "Not allowed.") });
    const { code, body } = await run(ctx, "session", "instructions", SESSION);
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it("instructions with no credential exits 3 and sends nothing", async () => {
    const { ctx, calls } = await setup({ config: null });
    const { code } = await run(ctx, "session", "instructions", SESSION);
    expect(code).toBe(ExitCode.Auth);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no session", ["session", "instructions"], /missing required argument/],
    ["a blank session", ["session", "instructions", "  "], /session is required/],
    ["a . session", ["session", "instructions", "."], /Not a valid session/],
    ["two sessions", ["session", "instructions", "ses-a", "ses-b"], /too many arguments/],
    ["an unknown flag", ["session", "instructions", SESSION, "--kind", "steer"], /unknown option/],
  ])("usage: instructions with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen ticket instructions", () => {
  const LIST = [instruction({ instruction_id: "ins-example-2", kind: "request_changes" }), QUEUED];

  it("instructions reads GET /tickets/{ref}/instructions and returns the list unchanged", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, LIST, "req_fake_ticket") });
    const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: LIST,
      error: null,
      meta: { ...META, request_id: "req_fake_ticket" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-7/instructions");
    expect(calls[0]?.url.search).toBe("");
  });

  it.each([["steer"], ["request_changes"]])(
    "instructions --kind %s is sent as the kind filter",
    async (kind) => {
      const { ctx, calls } = await setup({ respond: () => ok(200, [QUEUED]) });
      const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-7", "--kind", kind);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toMatchObject({ ok: true, data: [QUEUED] });
      expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA-7/instructions");
      expect(calls[0]?.url.search).toBe(`?kind=${kind}`);
    },
  );

  it("instructions returns dispatched and accepted instructions with their mode, and a returned one with its code, unchanged", async () => {
    const list = [RETURNED, ACCEPTED, DISPATCHED, DELIVERED];
    const { ctx } = await setup({ respond: () => ok(200, list, "req_fake_ticket") });
    const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-7");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: list,
      error: null,
      meta: { ...META, request_id: "req_fake_ticket" },
    });
    expect(
      (body.data as Record<string, unknown>[]).map((entry) => [
        entry["state"],
        entry["mode"],
        entry["return_code"],
      ]),
    ).toEqual([
      ["queued", "steer", "HARNESS_UNSUPPORTED"],
      ["accepted", "queue", null],
      ["dispatched", "steer", null],
      ["delivered", "steer", null],
    ]);
  });

  it("instructions --format table shows each instruction's state, mode and a returned one's code", async () => {
    const { ctx } = await setup({ respond: () => ok(200, [RETURNED, ACCEPTED, DISPATCHED]) });
    ctx.out.length = 0;
    const code = await runCli(["--format", "table", "ticket", "instructions", "ALPHA-7"], ctx);
    expect(code).toBe(ExitCode.Ok);
    // Human layout may use labeled sections for nested records; keep record associations.
    const sections = ctx.out
      .join("")
      .trimEnd()
      .split(/(?=^\[\d+\]$)/m)
      .filter((section) => section.startsWith("["));
    expect(sections).toHaveLength(3);
    for (const [index, instruction] of [RETURNED, ACCEPTED, DISPATCHED].entries()) {
      const section = sections[index]!;
      expect(section).toContain(String(instruction.instruction_id));
      expect(section).toMatch(new RegExp(`State:\\s+${instruction.state}\\b`));
      expect(section).toMatch(new RegExp(`Mode:\\s+${instruction.mode}\\b`));
      expect(section).toContain("Return code");
    }
    expect(sections[0]).toContain("HARNESS_UNSUPPORTED");
  });

  it("instructions' help names every state, dispatched and accepted among them, the modes and the return code", async () => {
    const text = await help("ticket", "instructions");
    for (const state of INSTRUCTION_STATES) expect(text).toMatch(new RegExp(`\\b${state}\\b`));
    expect(text).toMatch(/\bmode\b/);
    expect(text).toMatch(/\bqueue\b/);
    expect(text).toMatch(/return_code/);
  });

  it("instructions percent-encodes the ticket reference as one path segment", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, []) });
    await run(ctx, "ticket", "instructions", "ALPHA/../7");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets/ALPHA%2F..%2F7/instructions");
  });

  it("instructions of an unknown ticket (404 TICKET_NOT_FOUND) is not found, exit 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "TICKET_NOT_FOUND", "No such Ticket in the Account."),
    });
    const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-404");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });

  it("instructions refused by the server (422 INPUT_INVALID for a kind it does not know) exits 2", async () => {
    const { ctx } = await setup({
      respond: () =>
        publicError(422, "INPUT_INVALID", "kind is not one of steer, request_changes."),
    });
    const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-7");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
  });

  it("instructions against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-7");
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("instructions refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({ respond: () => publicError(403, "FORBIDDEN", "Not allowed.") });
    const { code, body } = await run(ctx, "ticket", "instructions", "ALPHA-7");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "FORBIDDEN" } });
  });

  it.each([
    ["no ticket", ["ticket", "instructions"], /missing required argument/],
    ["a blank ticket", ["ticket", "instructions", "  "], /ticket ref is required/],
    ["a .. ticket", ["ticket", "instructions", ".."], /Not a valid ticket ref/],
    ["two tickets", ["ticket", "instructions", "ALPHA-1", "ALPHA-2"], /too many arguments/],
    [
      "an unknown kind",
      ["ticket", "instructions", "ALPHA-7", "--kind", "feedback"],
      /feedback|kind/,
    ],
    ["an empty kind", ["ticket", "instructions", "ALPHA-7", "--kind", ""], /kind/],
    ["a missing kind value", ["ticket", "instructions", "ALPHA-7", "--kind"], /argument missing/],
    [
      "an unknown flag",
      ["ticket", "instructions", "ALPHA-7", "--state", "queued"],
      /unknown option/,
    ],
  ])("usage: instructions with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen session edit-instruction", () => {
  const OTHER = instruction({ instruction_id: "ins-example-2", version: 7 });
  const LISTED = [OTHER, instruction({ version: 4 })];
  const EDITED = instruction({ text: "Use the new helper.", version: 5 });

  /** Lists the session's instructions on GET, and applies the edit on PATCH. */
  function server(patch: (call: Call) => Response = () => ok(200, EDITED, "req_fake_edit")) {
    return (call: Call) => {
      if (call.method === "GET" && call.url.pathname === SESSION_PATH) {
        return ok(200, LISTED, "req_fake_list");
      }
      if (call.method === "PATCH") return patch(call);
      return publicError(404, "NOT_FOUND", "No such route.");
    };
  }

  it("edit-instruction reads the instruction's version from the list and sends it with the new text", async () => {
    const { ctx, calls } = await setup({ respond: server() });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Use the new helper.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: EDITED,
      error: null,
      meta: { ...META, request_id: "req_fake_edit" },
    });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", SESSION_PATH],
      ["PATCH", `${SESSION_PATH}/ins-example-1`],
    ]);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[1]?.body).toEqual({ text: "Use the new helper.", version: 4 });
    expect(calls[1]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    });
  });

  it("edit-instruction sends the version of the instruction it names, not another's", async () => {
    const { ctx, calls } = await setup({ respond: server() });
    await run(ctx, "session", "edit-instruction", SESSION, "ins-example-2", "--text", "Other.");
    expect(calls[1]?.url.pathname).toBe(`${SESSION_PATH}/ins-example-2`);
    expect(calls[1]?.body).toEqual({ text: "Other.", version: 7 });
  });

  it("edit-instruction -f sends the file's text", async () => {
    const { ctx, calls } = await setup({ respond: server() });
    const name = await file(ctx, "edit.txt", "Rewritten from a file.\n");
    const { code } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "-f",
      name,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual({ text: "Rewritten from a file.", version: 4 });
  });

  it("edit-instruction percent-encodes the session and the instruction as path segments", async () => {
    const listed = [instruction({ instruction_id: "ins/../x", version: 9 })];
    const { ctx, calls } = await setup({
      respond: (call) => (call.method === "GET" ? ok(200, listed) : ok(200, EDITED)),
    });
    const { code } = await run(
      ctx,
      "session",
      "edit-instruction",
      "ses/a",
      "ins/../x",
      "--text",
      "Hi.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.url.pathname).toBe("/api/v1/sessions/ses%2Fa/instructions");
    expect(calls[1]?.url.pathname).toBe("/api/v1/sessions/ses%2Fa/instructions/ins%2F..%2Fx");
    expect(calls[1]?.body).toEqual({ text: "Hi.", version: 9 });
  });

  it("edit-instruction of an instruction already delivered (409 INSTRUCTION_ALREADY_DELIVERED) is a refusal, exit 5", async () => {
    const { ctx, calls } = await setup({
      respond: server(() =>
        publicError(409, "INSTRUCTION_ALREADY_DELIVERED", "The instruction was already delivered."),
      ),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Too late.",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "INSTRUCTION_ALREADY_DELIVERED",
        message: "The instruction was already delivered.",
        details: { status: 409, request_id: "req_fake_error" },
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
  });

  it("edit-instruction still sends the change when the list shows the instruction as delivered, and leaves the refusal to the server", async () => {
    const listed = [DELIVERED];
    const { ctx, calls } = await setup({
      respond: (call) =>
        call.method === "GET"
          ? ok(200, listed)
          : publicError(
              409,
              "INSTRUCTION_ALREADY_DELIVERED",
              "The instruction was already delivered.",
            ),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Late.",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ error: { code: "INSTRUCTION_ALREADY_DELIVERED" } });
    expect(calls[1]?.body).toEqual({ text: "Late.", version: 2 });
  });

  it("edit-instruction of an instruction that changed since the list (409 INSTRUCTION_VERSION_STALE) is a refusal, exit 5", async () => {
    const { ctx } = await setup({
      respond: server(() =>
        publicError(409, "INSTRUCTION_VERSION_STALE", "The instruction changed since it was read."),
      ),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Race.",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, error: { code: "INSTRUCTION_VERSION_STALE" } });
  });

  it("edit-instruction of another person's instruction (403 INSTRUCTION_NOT_AUTHOR) keeps the server's code and exits 3", async () => {
    const { ctx } = await setup({
      respond: server(() =>
        publicError(403, "INSTRUCTION_NOT_AUTHOR", "Only the author may edit the instruction."),
      ),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Mine.",
    );
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INSTRUCTION_NOT_AUTHOR" },
    });
  });

  it("edit-instruction of an instruction the session does not list is INSTRUCTION_NOT_FOUND, exit 4, and sends no change", async () => {
    const { ctx, calls } = await setup({ respond: server() });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-missing",
      "--text",
      "Nope.",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "INSTRUCTION_NOT_FOUND",
        details: { session: SESSION, instruction: "ins-missing" },
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("edit-instruction of an unknown session (404 SESSION_NOT_FOUND on the list) exits 4 and sends no change", async () => {
    const { ctx, calls } = await setup({
      respond: () => publicError(404, "SESSION_NOT_FOUND", "No such session in the Account."),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      "ses-missing",
      "ins-example-1",
      "--text",
      "Hi.",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("edit-instruction against a server that lacks the routes reports its 404 and exits 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Hi.",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("edit-instruction refused by the server (422 STEER_EMPTY) exits 2 with its code", async () => {
    const { ctx } = await setup({
      respond: server(() => publicError(422, "STEER_EMPTY", "The instruction is empty.")),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      SESSION,
      "ins-example-1",
      "--text",
      "Hi.",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "STEER_EMPTY" } });
  });

  it.each([
    ["no session", ["session", "edit-instruction", "--text", "Hi."], /missing required argument/],
    [
      "no instruction",
      ["session", "edit-instruction", SESSION, "--text", "Hi."],
      /missing required argument/,
    ],
    [
      "a blank instruction",
      ["session", "edit-instruction", SESSION, " ", "--text", "Hi."],
      /instruction is required/,
    ],
    [
      "a .. instruction",
      ["session", "edit-instruction", SESSION, "..", "--text", "Hi."],
      /Not a valid instruction/,
    ],
    [
      "a . session",
      ["session", "edit-instruction", ".", "ins-example-1", "--text", "Hi."],
      /Not a valid session/,
    ],
    [
      "an extra argument",
      ["session", "edit-instruction", SESSION, "ins-example-1", "x", "--text", "Hi."],
      /too many arguments/,
    ],
    [
      "neither --text nor -f",
      ["session", "edit-instruction", SESSION, "ins-example-1"],
      /--text <text> or -f <file>/,
    ],
    [
      "both --text and -f",
      ["session", "edit-instruction", SESSION, "ins-example-1", "--text", "Hi.", "-f", "edit.txt"],
      /mutually exclusive/,
    ],
    [
      "an empty --text",
      ["session", "edit-instruction", SESSION, "ins-example-1", "--text", ""],
      /empty/,
    ],
    [
      "a --text over 8000 characters",
      ["session", "edit-instruction", SESSION, "ins-example-1", "--text", "x".repeat(8001)],
      /8000/,
    ],
    [
      "a missing --text value",
      ["session", "edit-instruction", SESSION, "ins-example-1", "--text"],
      /argument missing/,
    ],
    [
      "a missing file",
      ["session", "edit-instruction", SESSION, "ins-example-1", "-f", "missing.txt"],
      /Cannot read input file/,
    ],
    [
      "an unknown flag",
      ["session", "edit-instruction", SESSION, "ins-example-1", "--text", "Hi.", "--force"],
      /unknown option/,
    ],
  ])("usage: edit-instruction with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup({ respond: server() });
    await file(ctx, "edit.txt", "From a file.");
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen session withdraw-instruction", () => {
  const WITHDRAWN = instruction({
    state: "withdrawn",
    withdrawn_at: "2026-10-05T09:10:00Z",
    editable: false,
    version: 2,
  });

  it("withdraw-instruction posts to the withdraw route with no body and prints the withdrawn instruction", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, WITHDRAWN, "req_fake_withdraw") });
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      SESSION,
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: WITHDRAWN,
      error: null,
      meta: { ...META, request_id: "req_fake_withdraw" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(`${SESSION_PATH}/ins-example-1/withdraw`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("withdraw-instruction percent-encodes the session and the instruction as path segments", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(200, WITHDRAWN) });
    await run(ctx, "session", "withdraw-instruction", "ses/a", "ins/../x");
    expect(calls[0]?.url.pathname).toBe(
      "/api/v1/sessions/ses%2Fa/instructions/ins%2F..%2Fx/withdraw",
    );
  });

  it("withdraw-instruction of an instruction already delivered (409 INSTRUCTION_ALREADY_DELIVERED) is a refusal, exit 5", async () => {
    const { ctx, calls } = await setup({
      respond: () =>
        publicError(409, "INSTRUCTION_ALREADY_DELIVERED", "The instruction was already delivered."),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      SESSION,
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "INSTRUCTION_ALREADY_DELIVERED",
        details: { status: 409, request_id: "req_fake_error" },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("withdraw-instruction of another person's instruction (403 INSTRUCTION_NOT_AUTHOR) keeps the server's code and exits 3", async () => {
    const { ctx } = await setup({
      respond: () =>
        publicError(403, "INSTRUCTION_NOT_AUTHOR", "Only the author may withdraw the instruction."),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      SESSION,
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INSTRUCTION_NOT_AUTHOR" },
    });
  });

  it("withdraw-instruction of an unknown session (404 SESSION_NOT_FOUND) exits 4", async () => {
    const { ctx } = await setup({
      respond: () => publicError(404, "SESSION_NOT_FOUND", "No such session in the Account."),
    });
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      "ses-missing",
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "SESSION_NOT_FOUND" } });
  });

  it("withdraw-instruction against a server that lacks the route reports its 404 and exits 4", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      SESSION,
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "NOT_FOUND" } });
  });

  it("withdraw-instruction does not retry a lost response, since withdrawing again would be refused", async () => {
    const { ctx, calls } = await setup({
      respond: () => {
        throw new Error("connection reset");
      },
    });
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      SESSION,
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.Network);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no session", ["session", "withdraw-instruction"], /missing required argument/],
    ["no instruction", ["session", "withdraw-instruction", SESSION], /missing required argument/],
    [
      "a blank instruction",
      ["session", "withdraw-instruction", SESSION, " "],
      /instruction is required/,
    ],
    [
      "a . instruction",
      ["session", "withdraw-instruction", SESSION, "."],
      /Not a valid instruction/,
    ],
    [
      "a .. session",
      ["session", "withdraw-instruction", "..", "ins-example-1"],
      /Not a valid session/,
    ],
    [
      "an extra argument",
      ["session", "withdraw-instruction", SESSION, "ins-example-1", "x"],
      /too many arguments/,
    ],
    [
      "an unknown flag",
      ["session", "withdraw-instruction", SESSION, "ins-example-1", "--force"],
      /unknown option/,
    ],
  ])("usage: withdraw-instruction with %s exits 2 and sends nothing", async (_, argv, message) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "CLI_USAGE", message: expect.stringMatching(message) },
    });
    expect(calls).toHaveLength(0);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])(
  "resource presentation: session instructions at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({ respond: () => ok(200, [QUEUED, DELIVERED]) });
    ctx.io.stdoutColumns = columns;
    const argv = ["session", "instructions", SESSION];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const json = envelope(ctx);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    const output = ctx.out.join("");
    for (const value of ["Session instructions (2 displayed)", "State", "Text"])
      expect(output).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
    expect(json.ok).toBe(true);
  },
);

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])(
  "resource presentation: ticket instructions at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({ respond: () => ok(200, [QUEUED, DELIVERED]) });
    ctx.io.stdoutColumns = columns;
    const argv = ["ticket", "instructions", "ALPHA-12"];
    expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
    const json = envelope(ctx);
    const previousCalls = [...calls];
    const previousErrors = [...ctx.err];
    calls.length = 0;
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
    const output = ctx.out.join("");
    for (const value of ["Ticket instructions (2 displayed)", "State", "Text"])
      expect(output).toContain(value);
    expect(calls).toEqual(previousCalls);
    expect(ctx.err).toEqual(previousErrors);
    expect(json.ok).toBe(true);
  },
);

it.each([40, 80, 120])(
  "steering distinguishes queued instructions without changing delivery at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({ respond: () => ok(201, QUEUED) });
    ctx.io.stdoutColumns = columns;
    const json = await expectMutationParity(
      ctx,
      calls,
      ["session", "steer", SESSION, "--text", "Keep the existing retry helper."],
      ["Accepted — still pending.", QUEUED.instruction_id, "queued"],
      ExitCode.Ok,
      (call) => {
        const body = { ...(call.body as Record<string, unknown>) };
        expect(body["idempotency_key"]).toMatch(/^[a-f0-9-]{36}$/);
        delete body["idempotency_key"];
        return { ...call, body };
      },
    );
    expect(json.data).toEqual(QUEUED);
    expect(calls).toHaveLength(1);
  },
);
