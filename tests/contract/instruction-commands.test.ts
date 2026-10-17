import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { COMMITTED_DOCUMENT, useMockServer } from "../support/mock-server.js";

// The steering instruction commands against Prism mocking the committed contracts/openapi.json:
// Prism refuses a request whose body or query does not match the document, so a success here
// means the CLI sent a request the document accepts.

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

const INSTRUCTION_FIELDS = [
  "instruction_id",
  "kind",
  "ticket_id",
  "target_run_id",
  "target_node_id",
  "target_fan_out_key",
  "target_session_id",
  "delivered_session_id",
  "target_label",
  "author",
  "text",
  "artifact_refs",
  "source_message_ids",
  "presented_message_ids",
  "reviewed_revision",
  "request_key",
  "items",
  "state",
  "queued_at",
  "delivered_at",
  "acknowledged_at",
  "unapplied_at",
  "unapplied_reason",
  "withdrawn_at",
  "editable",
  "version",
  // Live delivery (ADR-142 §3, §9, §11), published from App Service release N.
  "mode",
  "deadline_seconds",
  "dispatched_at",
  "accepted_at",
  "consumed_at",
  "provider_message_ref",
  "return_code",
  "quoted_event_refs",
  "quoted_file_refs",
  "delivered_attempt",
  "dispatched_delivery_id",
  "dispatched_fencing_token",
];

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

/** A raw request to the mock, apart from the CLI's own checks. */
async function raw(method: string, path: string, body?: unknown): Promise<number> {
  const response = await globalThis.fetch(`${server().url}${path}`, {
    method,
    headers: {
      authorization: "Bearer pidgen_pat_fake_contract_token",
      "x-pidgen-account": "ACC-EXAMPLE",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status;
}

describe("the committed Instruction carries live delivery (ADR-142 1.0.1 §3, §9, §11)", () => {
  async function schemas(): Promise<Record<string, Record<string, unknown>>> {
    const document = JSON.parse(await readFile(COMMITTED_DOCUMENT, "utf8")) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    return document.components.schemas;
  }

  async function instructionProperties(): Promise<Record<string, Record<string, unknown>>> {
    return (await schemas())["Instruction"]!["properties"] as Record<
      string,
      Record<string, unknown>
    >;
  }

  it("every published field is required, the new ones included", async () => {
    const required = (await schemas())["Instruction"]!["required"] as string[];
    expect([...required].sort()).toEqual([...INSTRUCTION_FIELDS].sort());
  });

  it("state adds dispatched and accepted, and the existing states keep their place", async () => {
    const properties = await instructionProperties();
    expect(properties["state"]!["enum"]).toEqual([
      "queued",
      "dispatched",
      "accepted",
      "delivered",
      "acknowledged",
      "unapplied",
      "withdrawn",
    ]);
  });

  it("mode is steer, queue or the reserved interrupt; the abort deadline is nullable", async () => {
    const properties = await instructionProperties();
    expect(properties["mode"]).toMatchObject({
      type: "string",
      enum: ["steer", "queue", "interrupt"],
    });
    expect(properties["deadline_seconds"]!["anyOf"]).toEqual([
      { type: "integer" },
      { type: "null" },
    ]);
  });

  it("the live path's times, provider reference and return code are nullable", async () => {
    const properties = await instructionProperties();
    for (const field of ["dispatched_at", "accepted_at", "consumed_at"]) {
      expect(properties[field]!["anyOf"]).toEqual([
        { format: "date-time", type: "string" },
        { type: "null" },
      ]);
    }
    for (const field of ["provider_message_ref", "return_code"]) {
      expect(properties[field]!["anyOf"]).toEqual([{ type: "string" }, { type: "null" }]);
    }
  });

  it("the quoted transcript excerpts and file lines are provenance references", async () => {
    const properties = await instructionProperties();
    const events = properties["quoted_event_refs"] as { type: string; items: { $ref: string } };
    const files = properties["quoted_file_refs"] as { type: string; items: { $ref: string } };
    expect(events).toMatchObject({ type: "array" });
    expect(files).toMatchObject({ type: "array" });
    const all = await schemas();
    const ref = (pointer: string) => all[pointer.replace("#/components/schemas/", "")]!;
    expect(ref(events.items.$ref)["required"]).toEqual(["session_id", "event_id", "digest"]);
    // The instruction reports every field of a file quote; the request leaves the optional ones out.
    const fileRef = ref(files.items.$ref);
    expect(fileRef["required"]).toEqual([
      "path",
      "side",
      "start_line",
      "end_line",
      "source",
      "snapshot_commit_sha",
      "turn_id",
      "captured_at",
      "digest",
    ]);
    const fileProperties = fileRef["properties"] as Record<string, Record<string, unknown>>;
    expect(fileProperties["side"]!["enum"]).toEqual(["old", "new"]);
    expect(fileProperties["source"]!["enum"]).toEqual(["snapshot", "live_preview"]);
  });

  it("the steer request carries the composer's fields: mode, deadline, uploads and quotes", async () => {
    const all = await schemas();
    const request = all["SteerRequest"]!;
    const properties = request["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual([
      "artifact_refs",
      "deadline_seconds",
      "idempotency_key",
      "mode",
      "quoted_event_refs",
      "quoted_file_refs",
      "source_message_ids",
      "text",
      "upload_ids",
    ]);
    expect(request["required"]).toEqual(["text"]);
    expect(properties["mode"]).toMatchObject({
      type: "string",
      enum: ["steer", "queue", "interrupt"],
      default: "steer",
    });
    for (const field of ["upload_ids", "source_message_ids"]) {
      expect(properties[field]).toMatchObject({ type: "array", items: { type: "string" } });
    }
    expect(properties["quoted_event_refs"]).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/QuotedEventReference" },
    });
    expect(properties["quoted_file_refs"]).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/QuotedFileReference" },
    });
    const fileRef = all["QuotedFileReference"]!;
    expect(fileRef["required"]).toEqual([
      "path",
      "side",
      "start_line",
      "end_line",
      "source",
      "digest",
    ]);
  });

  it("the upload route the steer's upload_ids refer to is not published, so the CLI has no --upload yet", async () => {
    const document = JSON.parse(await readFile(COMMITTED_DOCUMENT, "utf8")) as {
      paths: Record<string, unknown>;
    };
    expect(document.paths).not.toHaveProperty("/api/v1/artifact-uploads");
  });
});

describe("the steering instruction commands against the Prism mock of the committed document", () => {
  it("pidgen session steer posts the text and the idempotency key, which the document accepts, and returns an instruction", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "session",
      "steer",
      "ses-example-1",
      "--text",
      "Prefer the existing retry helper.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    for (const field of INSTRUCTION_FIELDS) expect(body.data).toHaveProperty(field);
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/sessions/ses-example-1/instructions`],
    ]);
    expect(sent[0]?.body).toEqual({
      text: "Prefer the existing retry helper.",
      idempotency_key: expect.any(String),
    });
  });

  it("pidgen session steer with every composer flag steers in a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    await mkdir(join(ctx.cwd, "src"), { recursive: true });
    await writeFile(join(ctx.cwd, "src", "retention.py"), "def retain(days):\n    return days\n");
    const { code, body } = await run(
      ctx,
      "session",
      "steer",
      "ses-example-1",
      "--text",
      "When you finish, also update the guide.",
      "--queue",
      "--attach",
      "art-example-1",
      "--quote-message",
      "msg-example-1",
      "--quote-file",
      "src/retention.py:1-2@7a3c91e",
    );
    expect(body).toMatchObject({ ok: true, error: null });
    expect(code).toBe(ExitCode.Ok);
    for (const field of INSTRUCTION_FIELDS) expect(body.data).toHaveProperty(field);
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/sessions/ses-example-1/instructions`],
    ]);
    expect(sent[0]?.body).toMatchObject({
      mode: "queue",
      artifact_refs: [{ artifact_id: "art-example-1" }],
      source_message_ids: ["msg-example-1"],
      quoted_file_refs: [
        {
          path: "src/retention.py",
          side: "new",
          start_line: 1,
          end_line: 2,
          source: "snapshot",
          snapshot_commit_sha: "7a3c91e",
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      ],
    });
  });

  it("pidgen session instructions reads GET /sessions/{session}/instructions and returns instructions", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "session", "instructions", "ses-example-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBeGreaterThan(0);
    for (const entry of body.data as Record<string, unknown>[]) {
      for (const field of INSTRUCTION_FIELDS) expect(entry).toHaveProperty(field);
    }
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/sessions/ses-example-1/instructions`],
    ]);
  });

  it("pidgen ticket instructions reads GET /tickets/{ref}/instructions, with the kind filter when given", async () => {
    const { ctx, sent } = await setup();
    const all = await run(ctx, "ticket", "instructions", "ALPHA-7");
    expect(all.code).toBe(ExitCode.Ok);
    expect(all.body).toMatchObject({ ok: true, error: null });
    for (const entry of all.body.data as Record<string, unknown>[]) {
      for (const field of INSTRUCTION_FIELDS) expect(entry).toHaveProperty(field);
    }
    for (const kind of ["steer", "request_changes"]) {
      const filtered = await run(ctx, "ticket", "instructions", "ALPHA-7", "--kind", kind);
      expect(filtered.code).toBe(ExitCode.Ok);
      expect(filtered.body).toMatchObject({ ok: true, error: null });
    }
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/tickets/ALPHA-7/instructions`],
      ["GET", `${server().url}/api/v1/tickets/ALPHA-7/instructions?kind=steer`],
      ["GET", `${server().url}/api/v1/tickets/ALPHA-7/instructions?kind=request_changes`],
    ]);
  });

  it("pidgen session edit-instruction sends the version the list reported, in a body the document accepts", async () => {
    const { ctx, sent } = await setup();
    const listed = await run(ctx, "session", "instructions", "ses-example-1");
    const [first] = listed.body.data as { instruction_id: string; version: number }[];
    expect(first).toBeDefined();
    const { code, body } = await run(
      ctx,
      "session",
      "edit-instruction",
      "ses-example-1",
      first!.instruction_id,
      "--text",
      "Use the new helper.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    for (const field of INSTRUCTION_FIELDS) expect(body.data).toHaveProperty(field);
    const id = encodeURIComponent(first!.instruction_id);
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${server().url}/api/v1/sessions/ses-example-1/instructions`],
      ["GET", `${server().url}/api/v1/sessions/ses-example-1/instructions`],
      ["PATCH", `${server().url}/api/v1/sessions/ses-example-1/instructions/${id}`],
    ]);
    expect(sent[2]?.body).toEqual({ text: "Use the new helper.", version: first!.version });
  });

  it("pidgen session withdraw-instruction posts to the withdraw route with no body and returns the instruction", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "session",
      "withdraw-instruction",
      "ses-example-1",
      "ins-example-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null });
    for (const field of INSTRUCTION_FIELDS) expect(body.data).toHaveProperty(field);
    expect(sent.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${server().url}/api/v1/sessions/ses-example-1/instructions/ins-example-1/withdraw`],
    ]);
    expect(sent[0]?.body).toBeUndefined();
  });

  it("the document itself refuses a steer without text, an edit without a version, and an unknown kind", async () => {
    // Prism applies the committed schemas to a raw request, apart from the CLI's own checks.
    const steer = "/api/v1/sessions/ses-example-1/instructions";
    expect(await raw("POST", steer, { text: "Hello." })).toBe(201);
    expect(
      await raw("POST", steer, {
        text: "Hello.",
        artifact_refs: [{ artifact_id: "art-example-1" }],
        idempotency_key: "key-example-1",
      }),
    ).toBe(201);
    expect(await raw("POST", steer, {})).toBe(422);
    // The text's length is the server's to check (STEER_EMPTY, STEER_TOO_LONG); the CLI checks
    // it before sending (tests/commands/instructions.test.ts), so the mock accepts these raw.
    expect(await raw("POST", steer, { text: "" })).toBe(201);
    expect(await raw("POST", steer, { text: "x".repeat(8001) })).toBe(201);
    expect(await raw("POST", steer, { text: "Hello.", artifact_refs: [{}] })).toBe(422);
    expect(await raw("POST", steer, { text: "Hello.", mode: "queue" })).toBe(201);
    // interrupt is in the enum but reserved: a real server refuses it with MODE_UNSUPPORTED.
    expect(await raw("POST", steer, { text: "Hello.", mode: "interrupt" })).toBe(201);
    expect(await raw("POST", steer, { text: "Hello.", upload_ids: ["upl-example-1"] })).toBe(201);
    expect(await raw("POST", steer, { text: "Hello.", upload_ids: [1] })).toBe(422);
    expect(
      await raw("POST", steer, {
        text: "Hello.",
        source_message_ids: ["msg-example-1"],
        quoted_file_refs: [
          {
            path: "src/retention.py",
            side: "new",
            start_line: 1,
            end_line: 2,
            source: "snapshot",
            snapshot_commit_sha: "7a3c91e",
            digest: `sha256:${"a".repeat(64)}`,
          },
        ],
      }),
    ).toBe(201);
    expect(
      await raw("POST", steer, {
        text: "Hello.",
        quoted_file_refs: [{ path: "src/retention.py", side: "new", start_line: 1 }],
      }),
    ).toBe(422);

    const edit = `${steer}/ins-example-1`;
    expect(await raw("PATCH", edit, { text: "Hello.", version: 1 })).toBe(200);
    expect(await raw("PATCH", edit, { text: "Hello." })).toBe(422);
    expect(await raw("PATCH", edit, { version: 1 })).toBe(422);

    const ticket = "/api/v1/tickets/ALPHA-7/instructions";
    expect(await raw("GET", `${ticket}?kind=steer`)).toBe(200);
    expect(await raw("GET", `${ticket}?kind=feedback`)).toBe(422);
  });
});
