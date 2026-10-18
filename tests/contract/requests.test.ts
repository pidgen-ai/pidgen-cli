import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { committedDocumentForStaticMock, useMockServer } from "../support/mock-server.js";
import { publishedIssues } from "../support/published.js";

// The pidgen request commands against Prism mocking the committed contracts/openapi.json. Prism
// checks each request (path, query, credential, body) against the published document and answers
// with the fixtures below, which the command validates against the same document. The Request
// routes state no examples, so each answer is written here and checked against its published
// schema.

const STORED: Record<string, unknown> = {
  id: "conv-example-1",
  request_key: "REQ-7",
  state: "acknowledged",
  waiting_on_requester: false,
  kind: "bug",
  title: "Export button does nothing",
  body: "Clicking Export does nothing.",
  details: {
    steps: "Click Export.",
    expected: "A CSV downloads.",
    actual: "Nothing happens.",
    unknown: [],
  },
  urgency: "high",
  priority: null,
  labels: [],
  target: { kind: "project", id: "proj-example-a", name: "Alpha" },
  source: { id: "src-example-web", name: "Web", channel: "web" },
  external_ref: null,
  external_url: null,
  requester: { name: "Sam Example", contact: "sam@example.com" },
  fingerprint: "export-noop",
  occurrence_count: 1,
  close_reason: null,
  close_note: null,
  duplicate_of: null,
  duplicate_of_key: null,
  promoted: null,
  version: 3,
  created_at: "2026-10-14T09:00:00Z",
  updated_at: "2026-10-14T09:05:00Z",
};
const ATTACHMENT = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "screen.png",
  media_type: "image/png",
  size: 4,
};
const ENTRY_ID = "00000000-0000-4000-8000-0000000000e1";

/** Each Request route's answer, by its published schema. */
const ANSWERS: Array<
  [route: string, schema: Parameters<typeof publishedIssues>[0], body: unknown]
> = [
  [
    "POST /api/v1/requests",
    "RequestReceivedResponse",
    {
      status: "ok",
      data: { request: STORED, outcome: "created", entry_id: ENTRY_ID, occurrence_id: null },
      meta: {},
    },
  ],
  [
    "GET /api/v1/requests",
    "RequestListResponse",
    { status: "ok", data: [STORED], meta: { page: 1, per_page: 20, total: 1 } },
  ],
  [
    "GET /api/v1/requests/{request_id}",
    "RequestResponse",
    { status: "ok", data: STORED, meta: {} },
  ],
  [
    "GET /api/v1/requests/{request_id}/timeline",
    "RequestTimelineResponse",
    {
      status: "ok",
      data: [
        {
          id: ENTRY_ID,
          kind: "requester",
          author: { actor: null, name: "Sam Example", contact: "sam@example.com" },
          text: "Clicking Export does nothing.",
          channel: "web",
          attachments: [ATTACHMENT.id],
          files: [ATTACHMENT],
          created_at: "2026-10-14T09:00:00Z",
        },
      ],
      meta: {},
    },
  ],
  [
    "POST /api/v1/requests/{request_id}/attachments",
    "RequestAttachmentResponse",
    { status: "ok", data: ATTACHMENT, meta: {} },
  ],
  ...["acknowledge", "ask", "accept", "close"].map(
    (action) =>
      [
        `POST /api/v1/requests/{request_id}/${action}`,
        "RequestResponse",
        { status: "ok", data: STORED, meta: {} },
      ] as [string, Parameters<typeof publishedIssues>[0], unknown],
  ),
  [
    "POST /api/v1/requests/{request_id}/reply",
    "RequestEntryWrittenResponse",
    { status: "ok", data: { request: STORED, entry_id: ENTRY_ID }, meta: {} },
  ],
  [
    "POST /api/v1/requests/{request_id}/promote",
    "RequestPromotionResponse",
    {
      status: "ok",
      data: {
        request: {
          ...STORED,
          state: "promoted",
          promoted: { kind: "ticket", id: "TKT-example", ticket_key: "ALPHA-12", stage: null },
        },
        ticket_id: "TKT-example",
      },
      meta: {},
    },
  ],
];

const server = useMockServer(
  committedDocumentForStaticMock(
    Object.fromEntries(ANSWERS.map(([route, , body]) => [route, body])),
  ),
);

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Sent {
  method: string;
  url: string;
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
      sent.push({ method: init?.method ?? "GET", url: String(input) });
      return globalThis.fetch(input, init);
    },
  });
  return { ctx, sent };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(["--timeout", "10", ...argv], ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

const REQUEST = {
  id: "REQ-7",
  state: expect.any(String) as unknown,
  kind: expect.any(String) as unknown,
  title: expect.any(String) as unknown,
  version: expect.any(Number) as unknown,
  requester: expect.objectContaining({ name: expect.any(String) }) as unknown,
};

describe("pidgen request against the Prism mock of the published document", () => {
  it.each(ANSWERS)("the mock's answer to %s is the published %s", (_route, schema, body) => {
    expect(publishedIssues(schema, body)).toEqual([]);
  });

  it("submit sends the stated body, prints the outcome and URL, and uploads the evidence", async () => {
    const { ctx, sent } = await setup();
    await writeFile(join(ctx.cwd, "screen.png"), "\x89PNG");
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
      "Click Export.",
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
      "--evidence",
      "screen.png",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, error: null, meta: { account: "ACC-EXAMPLE" } });
    expect(body.data).toMatchObject({
      outcome: expect.stringMatching(/^(created|appended|occurrence|regression)$/),
      url: `${server().url}/requests/REQ-7?account=ACC-EXAMPLE`,
      request: REQUEST,
      attachments: [expect.objectContaining({ id: expect.any(String), size: expect.any(Number) })],
    });
    const id = (body.data as { request: { id: string } }).request.id;
    expect(sent).toEqual([
      { method: "POST", url: `${server().url}/api/v1/requests` },
      { method: "POST", url: `${server().url}/api/v1/requests/${id}/attachments` },
    ]);
  });

  it("list sends the filters and returns Requests", async () => {
    const { ctx, sent } = await setup();
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
      "--page",
      "1",
      "--per-page",
      "20",
    );
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    for (const item of body.data as unknown[]) expect(item).toMatchObject(REQUEST);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain(`${server().url}/api/v1/requests?`);
  });

  it("show returns the Request and its timeline with attachments", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "request", "show", "REQ-7");
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    const data = body.data as { request: unknown; timeline: Array<{ files: unknown[] }> };
    expect(data.request).toMatchObject(REQUEST);
    expect(data.timeline.length).toBeGreaterThan(0);
    expect(data.timeline.some((entry) => entry.files.length > 0)).toBe(true);
    expect(sent).toEqual([
      { method: "GET", url: `${server().url}/api/v1/requests/REQ-7` },
      { method: "GET", url: `${server().url}/api/v1/requests/REQ-7/timeline` },
    ]);
  });

  it.each([
    [["acknowledge", "REQ-7"], "acknowledge"],
    [["reply", "REQ-7", "--text", "Thanks."], "reply"],
    [["reply", "REQ-7", "--text", "Which browser?", "--ask"], "ask"],
    [["accept", "REQ-7", "--priority", "P2", "--unknown", "steps"], "accept"],
    [["close", "REQ-7", "--reason", "duplicate", "--duplicate-of", "REQ-3"], "close"],
    [["promote", "REQ-7", "--project", "ALPHA", "--no-refine"], "promote"],
  ])("pidgen request %j reads the version and sends the stated body", async (argv, action) => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "request", ...argv);
    expect(code, JSON.stringify(body.error)).toBe(ExitCode.Ok);
    expect((body.data as { state: unknown }).state).toEqual(expect.any(String));
    expect(sent).toEqual([
      { method: "GET", url: `${server().url}/api/v1/requests/REQ-7` },
      { method: "POST", url: `${server().url}/api/v1/requests/REQ-7/${action}` },
    ]);
  });
});
