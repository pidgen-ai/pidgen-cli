import { expectMutationParity } from "../support/context.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { NOUNS } from "../../src/core/registry.js";
import { REQUEST_REFUSALS } from "../../src/core/requests.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";
import { publishedIssues } from "../support/published.js";

// The pidgen request commands with a fake fetch answering fixtures shaped by the published document
// contracts/openapi.json: routes, request bodies, data, refusals and usage errors. The document
// states the Request routes with schemas but no examples, so the fixtures are written here and
// checked against it.

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

/** Every issue `value` has against the published schema `name`; empty when it matches. */
function issues(name: Parameters<typeof publishedIssues>[0], value: unknown) {
  return publishedIssues(name, value);
}

type Request = Record<string, unknown> & { id: string; state: string; version: number };

function request(overrides: Partial<Request> = {}): Request {
  return {
    id: "conv-example-1",
    state: "new",
    waiting_on_requester: false,
    kind: "bug",
    title: "Export button does nothing",
    body: "Clicking Export on the report page does nothing.",
    details: {
      steps: "Open a report and click Export.",
      expected: "A CSV downloads.",
      actual: "Nothing happens.",
      unknown: [],
    },
    urgency: "normal",
    priority: null,
    labels: [],
    target: { kind: "project", id: "proj-example-a", name: "Alpha" },
    source: { id: "src-example-web", name: "Web", channel: "web" },
    external_ref: null,
    external_url: null,
    requester: { name: "Sam Example", contact: "sam@example.com" },
    fingerprint: null,
    occurrence_count: 1,
    close_reason: null,
    close_note: null,
    duplicate_of: null,
    promoted: null,
    version: 3,
    created_at: "2026-10-14T09:00:00Z",
    updated_at: "2026-10-14T09:00:00Z",
    ...overrides,
  };
}

const REQUEST = request();
const TIMELINE = [
  {
    id: "00000000-0000-4000-8000-0000000000e1",
    kind: "requester",
    author: { actor: null, name: "Sam Example", contact: "sam@example.com" },
    text: "Clicking Export on the report page does nothing.",
    channel: "web",
    attachments: ["00000000-0000-4000-8000-0000000000a1"],
    files: [
      {
        id: "00000000-0000-4000-8000-0000000000a1",
        name: "screen.png",
        media_type: "image/png",
        size: 2048,
      },
    ],
    created_at: "2026-10-14T09:00:00Z",
  },
  {
    id: "00000000-0000-4000-8000-0000000000e2",
    kind: "system",
    author: { actor: null, name: null, contact: null },
    text: "Acknowledged.",
    channel: null,
    attachments: [],
    files: [],
    created_at: "2026-10-14T09:05:00Z",
  },
];

function ok(data: unknown, status = 200, meta: unknown = null) {
  return jsonResponse(
    status,
    { status: "ok", data, meta },
    { "x-request-id": "req_fake_ok", "pidgen-api-version": "1.0" },
  );
}

function refusal(status: number, code: string, details: Record<string, unknown> | null = null) {
  return jsonResponse(
    status,
    {
      status: "error",
      error: { code, message: `The server refuses: ${code}.`, details, request_id: "req_err" },
    },
    { "x-request-id": "req_fake_error" },
  );
}

/** Answers each Request route with its fixture. */
function byRoute(overrides: Partial<Record<string, () => Response>> = {}) {
  return (call: Call): Response => {
    const path = call.url.pathname.replace(/^\/api\/v1/, "");
    const key = `${call.method} ${path.replace(/^\/requests\/[^/]+/, "/requests/{id}")}`;
    const override = overrides[key];
    if (override) return override();
    switch (key) {
      case "POST /requests":
        return ok(
          {
            request: REQUEST,
            outcome: "created",
            entry_id: "00000000-0000-4000-8000-0000000000e1",
            occurrence_id: null,
          },
          201,
        );
      case "GET /requests":
        return ok([REQUEST], 200, { page: 1, per_page: 100, total: 1 });
      case "GET /requests/{id}":
        return ok(REQUEST);
      case "GET /requests/{id}/timeline":
        return ok(TIMELINE);
      case "POST /requests/{id}/attachments":
        return ok(
          {
            id: "00000000-0000-4000-8000-0000000000a9",
            name: "file",
            media_type: "image/png",
            size: 4,
          },
          201,
        );
      case "POST /requests/{id}/acknowledge":
        return ok(request({ state: "acknowledged", version: 4 }));
      case "POST /requests/{id}/ask":
        return ok(request({ state: "acknowledged", waiting_on_requester: true, version: 4 }));
      case "POST /requests/{id}/reply":
        return ok({
          request: request({ version: 4 }),
          entry_id: "00000000-0000-4000-8000-0000000000e3",
        });
      case "POST /requests/{id}/accept":
        return ok(request({ state: "accepted", priority: "P2", version: 4 }));
      case "POST /requests/{id}/close":
        return ok(request({ state: "closed", close_reason: "other", version: 4 }));
      case "POST /requests/{id}/promote":
        return ok({
          request: request({
            state: "promoted",
            promoted: { kind: "ticket", id: "TKT-example", stage: "refining" },
            version: 4,
          }),
          ticket_id: "TKT-example",
        });
    }
    throw new Error(`unexpected ${key}`);
  };
}

async function setup(respond: (call: Call) => Response = byRoute()) {
  const calls: Call[] = [];
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
  });
  await saveConfig(ctx, CONFIG);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function file(ctx: TestContext, name: string, content: string): Promise<string> {
  await writeFile(join(ctx.cwd, name), content);
  return name;
}

describe("the Request fixtures", () => {
  it("match the published schemas", () => {
    expect(issues("Request", REQUEST)).toEqual([]);
    for (const entry of TIMELINE) expect(issues("RequestTimelineEntry", entry)).toEqual([]);
  });
});

describe("pidgen request submit", () => {
  it("builds the stated body from its flags, sends it and prints the outcome and the page URL", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "request",
      "submit",
      "--kind",
      "bug",
      "--title",
      "Export button does nothing",
      "--body",
      "Clicking Export does nothing.",
      "--steps",
      "Open a report and click Export.",
      "--expected",
      "A CSV downloads.",
      "--actual",
      "Nothing happens.",
      "--urgency",
      "high",
      "--target",
      "project:proj-example-a",
      "--fingerprint",
      "export-noop",
      "--submission-key",
      "sub-example-1",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: new URL(`${SERVER}/api/v1/requests`) });
    expect(calls[0]?.body).toEqual({
      kind: "bug",
      title: "Export button does nothing",
      body: "Clicking Export does nothing.",
      details: {
        steps: "Open a report and click Export.",
        expected: "A CSV downloads.",
        actual: "Nothing happens.",
      },
      urgency: "high",
      target: { kind: "project", id: "proj-example-a" },
      fingerprint: "export-noop",
      submission_key: "sub-example-1",
    });
    expect(issues("RequestSubmitRequest", calls[0]?.body)).toEqual([]);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        outcome: "created",
        url: `${SERVER}/requests/conv-example-1`,
        request: { id: "conv-example-1", state: "new" },
        entry_id: "00000000-0000-4000-8000-0000000000e1",
        occurrence_id: null,
        attachments: [],
      },
      meta: { account: "ACC-EXAMPLE", request_id: "req_fake_ok" },
    });
  });

  it("without --submission-key sends a generated one, so a retry is the same submission", async () => {
    const { ctx, calls } = await setup();
    const { code } = await run(
      ctx,
      "request",
      "submit",
      "--kind",
      "question",
      "--title",
      "How do I export?",
      "--body",
      "Where is export?",
    );
    expect(code).toBe(ExitCode.Ok);
    const sent = calls[0]?.body as Record<string, unknown>;
    expect(sent["submission_key"]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(sent).not.toHaveProperty("details");
  });

  it("-f takes the stated body as JSON or YAML; the flags override it", async () => {
    const { ctx, calls } = await setup();
    await file(
      ctx,
      "request.yaml",
      [
        "kind: feature",
        "title: Dark mode",
        "body: Please add dark mode.",
        "external_ref: GH-12",
        "external_url: https://issues.example.com/12",
        "requester:",
        "  name: Sam Example",
        "  contact: sam@example.com",
        "",
      ].join("\n"),
    );
    const { code } = await run(
      ctx,
      "request",
      "submit",
      "-f",
      "request.yaml",
      "--urgency",
      "low",
      "--submission-key",
      "k1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({
      kind: "feature",
      title: "Dark mode",
      body: "Please add dark mode.",
      external_ref: "GH-12",
      external_url: "https://issues.example.com/12",
      requester: { name: "Sam Example", contact: "sam@example.com" },
      urgency: "low",
      submission_key: "k1",
    });
  });

  it("-f with a text or Markdown file is the body's text", async () => {
    const { ctx, calls } = await setup();
    await file(ctx, "report.md", "# Export\n\nNothing happens.\n");
    const { code } = await run(
      ctx,
      "request",
      "submit",
      "--kind",
      "task",
      "--title",
      "Export",
      "-f",
      "report.md",
      "--target",
      "domain:DOM-example-pay",
      "--submission-key",
      "k2",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({
      body: "# Export\n\nNothing happens.\n",
      target: { kind: "domain", id: "DOM-example-pay" },
    });
  });

  it.each([
    ["created", "entry_id", "00000000-0000-4000-8000-0000000000e1", null],
    ["appended", "entry_id", "00000000-0000-4000-8000-0000000000e2", null],
    ["occurrence", "occurrence_id", null, "00000000-0000-4000-8000-0000000000c1"],
    ["regression", "occurrence_id", null, "00000000-0000-4000-8000-0000000000c2"],
  ] as const)(
    "%s: --evidence uploads each file to the returned %s",
    async (outcome, field, entryId, occurrenceId) => {
      const { ctx, calls } = await setup(
        byRoute({
          "POST /requests": () =>
            ok(
              {
                request: REQUEST,
                outcome,
                entry_id: entryId,
                occurrence_id: occurrenceId,
              },
              outcome === "created" ? 201 : 200,
            ),
        }),
      );
      await file(ctx, "screen.png", "\x89PNG");
      await file(ctx, "console.log", "TypeError: x is undefined\n");
      const { code, body } = await run(
        ctx,
        "request",
        "submit",
        "--kind",
        "bug",
        "--title",
        "Export",
        "--body",
        "Nothing happens.",
        "--submission-key",
        "k3",
        "--evidence",
        "screen.png",
        "console.log",
      );
      expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        "POST /api/v1/requests",
        "POST /api/v1/requests/conv-example-1/attachments",
        "POST /api/v1/requests/conv-example-1/attachments",
      ]);
      const forms = calls.slice(1).map((call) => call.form!);
      const id = entryId ?? occurrenceId;
      for (const form of forms) {
        expect(form.get(field)).toBe(id);
        expect(form.has(field === "entry_id" ? "occurrence_id" : "entry_id")).toBe(false);
      }
      const files = forms.map((form) => form.get("file") as File);
      expect(files.map((f) => f.name)).toEqual(["screen.png", "console.log"]);
      expect(files[0]?.type).toBe("image/png");
      expect(files[1]?.type).toBe("text/plain");
      expect(await files[1]?.text()).toBe("TypeError: x is undefined\n");
      expect(body.data).toMatchObject({
        outcome,
        url: `${SERVER}/requests/conv-example-1`,
        attachments: [
          { id: "00000000-0000-4000-8000-0000000000a9" },
          { id: "00000000-0000-4000-8000-0000000000a9" },
        ],
      });
    },
  );

  it("a missing --evidence file is a usage error and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(
      ctx,
      "request",
      "submit",
      "--kind",
      "bug",
      "--title",
      "Export",
      "--body",
      "Nothing happens.",
      "--evidence",
      "missing.png",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });

  it("a refused upload names the request it filed", async () => {
    const { ctx } = await setup(
      byRoute({
        "POST /requests/{id}/attachments": () => refusal(413, "FILE_TOO_LARGE"),
      }),
    );
    await file(ctx, "big.bin", "x");
    const { code, body } = await run(
      ctx,
      "request",
      "submit",
      "--kind",
      "bug",
      "--title",
      "Export",
      "--body",
      "Nothing happens.",
      "--evidence",
      "big.bin",
    );
    expect(code).not.toBe(ExitCode.Ok);
    expect(body.error).toMatchObject({
      code: "FILE_TOO_LARGE",
      details: {
        request: "conv-example-1",
        outcome: "created",
        url: `${SERVER}/requests/conv-example-1`,
        file: "big.bin",
        uploaded: [],
      },
    });
  });

  it.each([
    ["no kind, title or body", ["request", "submit"], "INPUT_INVALID"],
    [
      "an unknown kind",
      ["request", "submit", "--kind", "epic", "--title", "t", "--body", "b"],
      "CLI_USAGE",
    ],
    [
      "an unknown urgency",
      ["request", "submit", "--kind", "bug", "--title", "t", "--body", "b", "--urgency", "now"],
      "CLI_USAGE",
    ],
    [
      "a target of an unknown kind",
      ["request", "submit", "--kind", "bug", "--title", "t", "--body", "b", "--target", "team:x"],
      "CLI_USAGE",
    ],
    [
      "both --body and -f",
      ["request", "submit", "--kind", "bug", "--title", "t", "--body", "b", "-f", "x.md"],
      "CLI_USAGE",
    ],
    [
      "an argument",
      ["request", "submit", "--kind", "bug", "--title", "t", "--body", "b", "extra"],
      "CLI_USAGE",
    ],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv, errorCode) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: errorCode } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen request list", () => {
  it("sends the filters and follows every page", async () => {
    const page = Array.from({ length: 100 }, (_, i) => request({ id: `conv-example-${i}` }));
    const { ctx, calls } = await setup((call) =>
      call.url.searchParams.get("page") === "1"
        ? ok(page, 200, { page: 1, per_page: 100, total: 101 })
        : ok([REQUEST], 200, { page: 2, per_page: 100, total: 101 }),
    );
    const { code, body } = await run(
      ctx,
      "request",
      "list",
      "--state",
      "new",
      "--kind",
      "bug",
      "--target",
      "project:ALPHA",
      "--source",
      "src-example-web",
      "--query",
      "export",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect((body.data as unknown[]).length).toBe(101);
    expect(calls).toHaveLength(2);
    for (const [index, call] of calls.entries()) {
      expect(call.method).toBe("GET");
      expect(call.url.pathname).toBe("/api/v1/requests");
      expect(Object.fromEntries(call.url.searchParams)).toEqual({
        state: "new",
        kind: "bug",
        target_kind: "project",
        target_id: "ALPHA",
        source_id: "src-example-web",
        q: "export",
        page: String(index + 1),
        per_page: "100",
      });
    }
  });

  it("--page and --per-page read one page", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "request", "list", "--page", "3", "--per-page", "20");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual([REQUEST]);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ page: "3", per_page: "20" });
  });

  it("an answer that does not match the published document is UNEXPECTED_RESPONSE", async () => {
    const { ctx } = await setup(() => ok([{ id: "conv-x" }], 200, { page: 1, per_page: 100 }));
    const { code, body } = await run(ctx, "request", "list");
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it.each([
    ["an unknown state", ["request", "list", "--state", "open"]],
    ["an unknown kind", ["request", "list", "--kind", "epic"]],
    ["a page of 0", ["request", "list", "--page", "0"]],
    ["a per-page over 100", ["request", "list", "--per-page", "101"]],
    ["an empty source", ["request", "list", "--source", " "]],
    ["an argument", ["request", "list", "conv-1"]],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen request show", () => {
  it("prints the Request, its requester with contact, and its timeline with attachments", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "request", "show", "conv-example-1");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /api/v1/requests/conv-example-1",
      "GET /api/v1/requests/conv-example-1/timeline",
    ]);
    expect(body.data).toEqual({ request: REQUEST, timeline: TIMELINE });
    const data = body.data as { request: Request; timeline: typeof TIMELINE };
    expect(data.request["requester"]).toEqual({ name: "Sam Example", contact: "sam@example.com" });
    expect(data.timeline[0]?.files[0]).toMatchObject({ name: "screen.png" });
  });

  it("leaves out the requester's contact when the server withholds it", async () => {
    const { ctx } = await setup(
      byRoute({
        "GET /requests/{id}": () =>
          ok(request({ requester: { name: "Sam Example", contact: null } })),
      }),
    );
    const { code, body } = await run(ctx, "request", "show", "conv-example-1");
    expect(code).toBe(ExitCode.Ok);
    const requester = (body.data as { request: Request }).request["requester"];
    expect(requester).toEqual({ name: "Sam Example" });
  });

  it("prints a Request with no requester or source as the server answers it", async () => {
    const anonymous = request({ requester: null, source: null, urgency: null });
    expect(issues("Request", anonymous)).toEqual([]);
    const { ctx } = await setup(byRoute({ "GET /requests/{id}": () => ok(anonymous) }));
    const { code, body } = await run(ctx, "request", "show", "conv-example-1");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect((body.data as { request: Request }).request).toEqual(anonymous);
  });

  it("an unknown request exits 4 with REQUEST_NOT_FOUND and its sentence", async () => {
    const { ctx } = await setup(() => refusal(404, "REQUEST_NOT_FOUND"));
    const { code, body } = await run(ctx, "request", "show", "conv-missing");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error).toMatchObject({
      code: "REQUEST_NOT_FOUND",
      message: REQUEST_REFUSALS.REQUEST_NOT_FOUND.sentence,
    });
  });

  it.each([
    ["no request", ["request", "show"]],
    ["a request of ..", ["request", "show", ".."]],
  ])("%s is a usage error and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup();
    const { code } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen request triage", () => {
  it.each([
    [["request", "acknowledge", "conv-example-1"], "acknowledge", { version: 3 }, "acknowledged"],
    [
      ["request", "reply", "conv-example-1", "--text", "Thanks, looking."],
      "reply",
      { version: 3, text: "Thanks, looking." },
      "new",
    ],
    [
      ["request", "reply", "conv-example-1", "--text", "Which browser?", "--ask"],
      "ask",
      { version: 3, text: "Which browser?" },
      "acknowledged",
    ],
    [
      ["request", "accept", "conv-example-1", "--priority", "P2", "--unknown", "steps", "actual"],
      "accept",
      { version: 3, priority: "P2", unknown: ["steps", "actual"] },
      "accepted",
    ],
    [["request", "accept", "conv-example-1"], "accept", { version: 3 }, "accepted"],
    [
      ["request", "close", "conv-example-1", "--reason", "other", "--note", "Not ours."],
      "close",
      { version: 3, reason: "other", note: "Not ours." },
      "closed",
    ],
    [
      ["request", "close", "conv-example-1", "--reason", "duplicate", "--duplicate-of", "conv-0"],
      "close",
      { version: 3, reason: "duplicate", duplicate_of: "conv-0" },
      "closed",
    ],
    [
      ["request", "promote", "conv-example-1", "--project", "proj-example-a"],
      "promote",
      { version: 3, project_id: "proj-example-a" },
      "promoted",
    ],
    // Without --project the Ticket goes to the Project the request targets.
    [["request", "promote", "conv-example-1"], "promote", { version: 3 }, "promoted"],
    [
      [
        "request",
        "promote",
        "conv-example-1",
        "--project",
        "ALPHA",
        "--workflow-type",
        "bugfix",
        "--no-refine",
      ],
      "promote",
      { version: 3, project_id: "ALPHA", workflow_type: "bugfix", start_refinement: false },
      "promoted",
    ],
  ] as const)(
    "pidgen %j reads the version, sends it and prints the new state",
    async (argv, action, sent, state) => {
      const { ctx, calls } = await setup();
      const { code, body } = await run(ctx, ...argv);
      expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        "GET /api/v1/requests/conv-example-1",
        `POST /api/v1/requests/conv-example-1/${action}`,
      ]);
      expect(calls[1]?.body).toEqual(sent);
      const data = body.data as Record<string, unknown> & { request?: Request };
      expect(data["state"]).toBe(state);
      expect((data.request ?? data)["state"]).toBe(state);
      if (action === "promote") expect(data["ticket_id"]).toBe("TKT-example");
      if (action === "reply") expect(data["entry_id"]).toBe("00000000-0000-4000-8000-0000000000e3");
    },
  );

  it.each([
    ["close without --reason", ["request", "close", "conv-1"]],
    [
      "close duplicate without --duplicate-of",
      ["request", "close", "conv-1", "--reason", "duplicate"],
    ],
    ["close other without --note", ["request", "close", "conv-1", "--reason", "other"]],
    ["reply without --text", ["request", "reply", "conv-1"]],
    ["accept with an unknown priority", ["request", "accept", "conv-1", "--priority", "P9"]],
    ["accept with an unknown field", ["request", "accept", "conv-1", "--unknown", "logs"]],
    ["close with an unknown reason", ["request", "close", "conv-1", "--reason", "spam"]],
    ["promote with an empty --project", ["request", "promote", "conv-1", "--project", " "]],
    ["acknowledge without a request", ["request", "acknowledge"]],
  ])("%s is a usage error (exit 2) and sends nothing", async (_name, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "CLI_USAGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("the Request refusals", () => {
  const CASES = [
    [
      "REQUEST_NOT_FOUND",
      404,
      ExitCode.NotFound,
      ["request", "acknowledge", "conv-example-1"],
      "GET",
    ],
    [
      "REQUEST_VERSION_CONFLICT",
      409,
      ExitCode.Refused,
      ["request", "acknowledge", "conv-example-1"],
      "POST",
    ],
    [
      "REQUEST_TRANSITION_REFUSED",
      409,
      ExitCode.Refused,
      ["request", "close", "conv-example-1", "--reason", "other", "--note", "n"],
      "POST",
    ],
    [
      "REQUEST_RATE_LIMITED",
      429,
      ExitCode.Refused,
      ["request", "submit", "--kind", "bug", "--title", "t", "--body", "b"],
      "POST",
    ],
    [
      "REQUEST_SOURCE_PAUSED",
      409,
      ExitCode.Refused,
      ["request", "submit", "--kind", "bug", "--title", "t", "--body", "b"],
      "POST",
    ],
    [
      "REQUEST_BUG_DETAILS_REQUIRED",
      422,
      ExitCode.Refused,
      ["request", "accept", "conv-example-1"],
      "POST",
    ],
    [
      "REQUEST_TARGET_NEEDS_PROJECT",
      422,
      ExitCode.Refused,
      ["request", "promote", "conv-example-1", "--project", "ALPHA"],
      "POST",
    ],
    [
      "REQUEST_REPLIES_OFF",
      422,
      ExitCode.Refused,
      ["request", "reply", "conv-example-1", "--text", "hi"],
      "POST",
    ],
  ] as const;

  it("every stated refusal code has its own sentence", () => {
    expect(Object.keys(REQUEST_REFUSALS).sort()).toEqual(CASES.map(([code]) => code).sort());
    const sentences = Object.values(REQUEST_REFUSALS).map(({ sentence }) => sentence);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].*\.$/);
  });

  it.each(CASES)(
    "%s (HTTP %i) prints its sentence and exits %i",
    async (errorCode, status, exit, argv, method) => {
      const { ctx } = await setup((call) =>
        call.method === method ? refusal(status, errorCode, { hint: "x" }) : byRoute()(call),
      );
      const { code, body } = await run(ctx, ...argv);
      expect(code).toBe(exit);
      expect(REQUEST_REFUSALS[errorCode].exit).toBe(exit);
      expect(body).toMatchObject({
        ok: false,
        data: null,
        error: {
          code: errorCode,
          message: REQUEST_REFUSALS[errorCode].sentence,
          details: { status, hint: "x", server_message: `The server refuses: ${errorCode}.` },
        },
      });
    },
  );
});

describe("the request commands' documentation", () => {
  it("the noun is registered and docs/commands.md lists every verb", async () => {
    expect(NOUNS["request"]).toMatch(/request/i);
    const text = await readFile(new URL("../../docs/commands.md", import.meta.url), "utf8");
    expect(text).toContain("## request");
    for (const verb of [
      "submit",
      "list",
      "show",
      "reply",
      "acknowledge",
      "accept",
      "close",
      "promote",
    ]) {
      expect(text).toContain(`pidgen request ${verb}`);
    }
    for (const code of Object.keys(REQUEST_REFUSALS)) expect(text).toContain(code);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: request list at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["request", "list"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Requests (1 displayed)", REQUEST.id, REQUEST.title, "new"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: request show at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["request", "show", REQUEST.id];
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
    "Request",
    "Timeline (2 displayed)",
    "Attachments (1 displayed)",
    "screen.png",
    REQUEST.title,
  ])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

it.each([40, 80, 120])(
  "request promotion keeps its version guard and promotion state at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup();
    ctx.io.stdoutColumns = columns;
    const json = await expectMutationParity(
      ctx,
      calls,
      ["request", "promote", REQUEST.id, "--project", "ALPHA"],
      ["request promote", "TKT-example", "promoted", "refining"],
    );
    expect(json.ok).toBe(true);
    expect(calls).toHaveLength(2);
  },
);
