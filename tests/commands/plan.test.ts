import { expectMutationParity } from "../support/context.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runCli } from "../../src/cli.js";
import { PUBLIC_API_DOCUMENT } from "../../src/commands/api/document.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { validateBody } from "../../src/core/input.js";
import { PLAN_TEMPLATE_YAML } from "../../src/commands/plan/template.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const ROOT = "PIDGEN-4";
const PLAN_PATH = `/api/v1/tickets/${ROOT}/child-plan`;
const PREVIEW_PATH = `${PLAN_PATH}/preview`;
const STATUS_PATH = `${PLAN_PATH}/applications/cmd-1`;

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

const PLAN = {
  summary: "Two slices",
  children: [
    {
      key: "first",
      title: "First slice",
      objective: "Do the first thing.",
      workflow_type: "implementation",
    },
    {
      key: "second",
      title: "Second slice",
      objective: "Do the next thing.",
      workflow_type: "implementation",
    },
  ],
  dependencies: [{ source: "first", target: "second" }],
};

/**
 * New children (by `key`) beside kept ones (by `plan_item_id`); one new child selects its Agent.
 */
const MIXED_PLAN = {
  ...PLAN,
  children: [
    { ...PLAN.children[0], team_member_id: "AGENT-EXAMPLE-A" },
    { ...PLAN.children[1], key: undefined, plan_item_id: "item-kept" },
    { ...PLAN.children[0], key: "another-new", title: "Another new child" },
    {
      ...PLAN.children[1],
      key: undefined,
      plan_item_id: "item-preserved",
      title: "Preserved child",
    },
  ],
  dependencies: [],
};

const CURRENT_PLAN = {
  root_ticket_id: "tkt-example-root",
  ticket_version: 7,
  materialized_plan_digest: "sha256:plan-current",
  items: [],
  dependencies: [],
  validation_findings: [],
};

function preview(required: string[] = []) {
  return {
    plan: PLAN,
    preview_digest: "sha256:preview-1",
    required_acknowledgements: required,
    root_ticket_id: "tkt-example-root",
    ticket_version: 7,
    materialized_plan_digest: "sha256:plan-current",
    effects: { created: ["first", "second"], retained: [], superseded: [] },
  };
}

function applyResult(status: "applied" | "applying" = "applied") {
  return {
    command_id: "cmd-1",
    status,
    status_url: `${SERVER}${STATUS_PATH}`,
    root_ticket_id: "tkt-example-root",
    materialized_plan_digest: status === "applied" ? "sha256:plan-new" : null,
    items: [],
    superseded_ticket_ids: [],
  };
}

function ok(data: unknown, status = 200): Response {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": "req-example" },
  );
}

function refusal(status: number, code: string, message: string, details: object | null = null) {
  return jsonResponse(status, {
    status: "error",
    error: { code, message, details, request_id: "req-example" },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

/** A fake server answering each `METHOD path` with its queued responses, in order. */
async function setup(routes: Record<string, Response[]> = {}, config: Config | null = CONFIG) {
  const calls: Call[] = [];
  const ctx = await testContext({
    fetch: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const next = routes[`${method} ${url.pathname}`]?.shift();
      if (next === undefined)
        return Promise.reject(new Error(`unexpected ${method} ${url.pathname}`));
      return Promise.resolve(next);
    },
  });
  if (config) await saveConfig(ctx, config);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function writePlan(ctx: TestContext, plan: unknown = PLAN, name = "plan.json") {
  const path = join(ctx.cwd, name);
  await writeFile(path, JSON.stringify(plan));
  return name;
}

describe("pidgen plan show", () => {
  it("show returns the plan with its version and digest", async () => {
    const { ctx, calls } = await setup({ [`GET ${PLAN_PATH}`]: [ok(CURRENT_PLAN)] });
    const { code, body } = await run(ctx, "plan", "show", ROOT);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: { ticket_version: 7, materialized_plan_digest: "sha256:plan-current", items: [] },
      meta: { request_id: "req-example", profile: "default", account: "ACC-EXAMPLE" },
    });
    expect(calls).toEqual([
      expect.objectContaining({ method: "GET", path: PLAN_PATH, body: undefined }),
    ]);
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("show returns a plan never applied, with a null digest", async () => {
    const { ctx } = await setup({
      [`GET ${PLAN_PATH}`]: [ok({ ...CURRENT_PLAN, materialized_plan_digest: null })],
    });
    const { code, body } = await run(ctx, "plan", "show", ROOT);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ ticket_version: 7, materialized_plan_digest: null });
  });

  it("show of a child ticket is refused with the server's code and exits 5", async () => {
    const { ctx } = await setup({
      [`GET ${PLAN_PATH}`]: [
        refusal(409, "HIGH_LEVEL_TICKET_REQUIRED", "The Ticket has a parent."),
      ],
    });
    const { code, body } = await run(ctx, "plan", "show", ROOT);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "HIGH_LEVEL_TICKET_REQUIRED", details: { status: 409 } },
    });
  });

  it("show of an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup({
      [`GET ${PLAN_PATH}`]: [refusal(404, "TICKET_NOT_FOUND", "No such Ticket.")],
    });
    const { code, body } = await run(ctx, "plan", "show", ROOT);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("TICKET_NOT_FOUND");
  });

  it("show refuses a plan without its version as an unexpected response", async () => {
    const { ctx } = await setup({
      [`GET ${PLAN_PATH}`]: [ok({ ...CURRENT_PLAN, ticket_version: undefined })],
    });
    const { code, body } = await run(ctx, "plan", "show", ROOT);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });
});

describe("pidgen plan apply", () => {
  it.each(["json", "yaml"])(
    "%s preserves new and kept children through preview, acknowledged apply and durable polling",
    async (format) => {
      const { ctx, calls } = await setup({
        [`POST ${PREVIEW_PATH}`]: [ok({ ...preview(["supersedes_children"]), plan: MIXED_PLAN })],
        [`PUT ${PLAN_PATH}`]: [ok(applyResult("applying"), 202)],
        [`GET ${STATUS_PATH}`]: [ok(applyResult("applying"), 202), ok(applyResult())],
      });
      const name = `assigned.${format}`;
      await writeFile(
        join(ctx.cwd, name),
        format === "yaml" ? stringify(MIXED_PLAN) : JSON.stringify(MIXED_PLAN),
      );
      const expectedPlan = JSON.parse(JSON.stringify(MIXED_PLAN)) as unknown;
      const previewed = await run(ctx, "plan", "apply", ROOT, "-f", name);
      expect(previewed.code).toBe(ExitCode.Ok);
      expect(previewed.body).toMatchObject({ ok: true, error: null, data: { plan: expectedPlan } });
      const digest = previewed.body.data?.["preview_digest"] as string;
      const applied = await run(
        ctx,
        "plan",
        "apply",
        ROOT,
        "-f",
        name,
        "--apply",
        "--digest",
        digest,
        "--ack",
        "supersedes-children",
      );
      expect(applied.code).toBe(ExitCode.Ok);
      const key = deriveIdempotencyKey({ command: "plan apply", target: ROOT }, digest, [
        "supersedes_children",
      ]);
      expect(applied.body).toMatchObject({
        ok: true,
        error: null,
        data: {
          settled: true,
          idempotency_key: key,
          result: { status: "applied" },
        },
      });
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", PREVIEW_PATH],
        ["PUT", PLAN_PATH],
        ["GET", STATUS_PATH],
        ["GET", STATUS_PATH],
      ]);
      expect(calls[0]?.body).toEqual({ plan: expectedPlan });
      expect(calls[1]?.body).toEqual({
        plan: expectedPlan,
        preview_digest: digest,
        acknowledgements: ["supersedes_children"],
        idempotency_key: key,
      });
    },
  );

  it.each(["new", "kept"])(
    "refuses a team_member_id on %s children that is not an Agent ID of 1-80 characters, before preview or apply",
    async (kind) => {
      for (const team_member_id of ["a".repeat(81), 42, "", null]) {
        for (const apply of [false, true]) {
          const { ctx, calls } = await setup();
          const child = {
            title: "A child",
            objective: "An outcome",
            workflow_type: "implementation",
            ...(kind === "new" ? { key: "new" } : { plan_item_id: "item-kept" }),
            team_member_id,
          };
          const file = await writePlan(ctx, { children: [child] });
          const flags = apply ? ["--apply", "--digest", "sha256:preview-1"] : [];
          const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file, ...flags);
          expect(code).toBe(ExitCode.Usage);
          expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
          expect(body.error?.details["issues"]).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: "$.children[0].team_member_id" }),
            ]),
          );
          expect(calls).toHaveLength(0);
        }
      }
    },
  );

  it.each(["preview", "apply"])(
    "%s preserves public refusal envelopes and exit codes",
    async (phase) => {
      for (const [status, errorCode, exit] of [
        [409, "CHILD_PLAN_INVALID", ExitCode.Refused],
        [403, "FORBIDDEN", ExitCode.Auth],
        [422, "INPUT_INVALID", ExitCode.Usage],
        [404, "TICKET_NOT_FOUND", ExitCode.NotFound],
        [409, "PREVIEW_STALE", ExitCode.ConfirmationRequired],
        [404, "TEAM_MEMBER_NOT_FOUND", ExitCode.NotFound],
        [409, "PLAN_ITEM_AGENT_FIXED", ExitCode.Refused],
      ] as const) {
        const path = phase === "preview" ? PREVIEW_PATH : PLAN_PATH;
        const method = phase === "preview" ? "POST" : "PUT";
        const { ctx, calls } = await setup({
          [`${method} ${path}`]: [
            refusal(status, errorCode, "Server declined the plan.", { plan_item_id: "item-kept" }),
          ],
        });
        const file = await writePlan(ctx, MIXED_PLAN);
        const flags = phase === "apply" ? ["--apply", "--digest", "sha256:preview-1"] : [];
        const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file, ...flags);
        expect(code).toBe(exit);
        expect(body).toMatchObject({
          ok: false,
          data: null,
          error: {
            code: errorCode,
            details: { status, request_id: "req-example", plan_item_id: "item-kept" },
          },
        });
        expect(body.error?.message).toContain("Server declined the plan.");
        expect(calls.map((call) => [call.method, call.path])).toEqual([[method, path]]);
      }
    },
  );

  it("apply previews by default and changes nothing", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const file = await writePlan(ctx);
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      data: {
        preview_digest: "sha256:preview-1",
        required_acknowledgements: [],
        ticket_version: 7,
        materialized_plan_digest: "sha256:plan-current",
      },
      meta: { request_id: "req-example" },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(calls[0]?.body).toEqual({ plan: PLAN });
  });

  it("apply with --apply and --digest sends the plan, that digest and a derived idempotency key", async () => {
    const { ctx, calls } = await setup({ [`PUT ${PLAN_PATH}`]: [ok(applyResult())] });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Ok);
    const key = deriveIdempotencyKey(
      { command: "plan apply", target: ROOT },
      "sha256:preview-1",
      [],
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT ${PLAN_PATH}`]);
    expect(calls[0]?.body).toEqual({
      plan: PLAN,
      preview_digest: "sha256:preview-1",
      idempotency_key: key,
      acknowledgements: [],
    });
    expect(body).toMatchObject({
      ok: true,
      data: { settled: true, idempotency_key: key, result: { status: "applied" } },
    });
  });

  it("apply with --apply alone previews, then applies the digest the preview read", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview())],
      [`PUT ${PLAN_PATH}`]: [ok(applyResult())],
    });
    const file = await writePlan(ctx);
    const { code } = await run(ctx, "plan", "apply", ROOT, "-f", file, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${PREVIEW_PATH}`,
      `PUT ${PLAN_PATH}`,
    ]);
    expect(calls[1]?.body).toMatchObject({ plan: PLAN, preview_digest: "sha256:preview-1" });
  });

  it("apply with --apply alone exits 6 when the preview needs an acknowledgement, and applies nothing", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok({ ...preview(["supersedes_children"]), plan: MIXED_PLAN })],
    });
    const file = await writePlan(ctx, MIXED_PLAN);
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file, "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error).toMatchObject({
      code: "DIGEST_REQUIRED",
      details: { preview: { required_acknowledgements: ["supersedes_children"] } },
    });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("apply passes only the --ack codes given, and never adds one", async () => {
    const { ctx, calls } = await setup({ [`PUT ${PLAN_PATH}`]: [ok(applyResult())] });
    const file = await writePlan(ctx);
    const { code } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--ack",
      "supersedes-children",
      "--reason",
      "Regroup the slices",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toMatchObject({
      acknowledgements: ["supersedes_children"],
      reason: "Regroup the slices",
    });
  });

  it("apply waits on the status route of a 202 until it settles", async () => {
    const { ctx, calls } = await setup({
      [`PUT ${PLAN_PATH}`]: [ok(applyResult("applying"), 202)],
      [`GET ${STATUS_PATH}`]: [ok(applyResult("applying"), 202), ok(applyResult())],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `PUT ${PLAN_PATH}`,
      `GET ${STATUS_PATH}`,
      `GET ${STATUS_PATH}`,
    ]);
    expect(body.data).toMatchObject({ settled: true, result: { status: "applied" } });
  });

  it("apply with --no-wait returns the applying result and its status route", async () => {
    const { ctx } = await setup({ [`PUT ${PLAN_PATH}`]: [ok(applyResult("applying"), 202)] });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--no-wait",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ settled: false, handle: STATUS_PATH });
  });

  it("apply of a stale preview exits 6 with PREVIEW_STALE and says what to do next", async () => {
    const { ctx } = await setup({
      [`PUT ${PLAN_PATH}`]: [refusal(409, "PREVIEW_STALE", "The plan changed since the preview.")],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:old",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
    expect(body.error?.details["next"]).toMatch(/Preview again/);
  });
});

describe("pidgen plan apply: a refused plan", () => {
  it("a plan refused by the preview with 409 exits 5 with the server's code", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [
        refusal(409, "PLAN_ALREADY_ADMITTED", "The plan was already admitted."),
      ],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "PLAN_ALREADY_ADMITTED", details: { status: 409, request_id: "req-example" } },
    });
    expect(calls).toHaveLength(1);
  });

  it("a plan refused by the apply with 200 exits 5 with its disposition code", async () => {
    const refused = {
      command_id: "cmd-1",
      status: "refused",
      disposition_code: "SUBJECT_EXECUTION_READINESS_FAILED",
      disposition_detail: "The root ticket is not ready for execution.",
    };
    const { ctx } = await setup({ [`PUT ${PLAN_PATH}`]: [ok(refused)] });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "SUBJECT_EXECUTION_READINESS_FAILED",
        message: "The root ticket is not ready for execution.",
        details: {
          status: 200,
          disposition_code: "SUBJECT_EXECUTION_READINESS_FAILED",
          result: { status: "refused" },
        },
      },
    });
  });

  it("a plan refused with 200 and only a disposition code still exits 5", async () => {
    const { ctx } = await setup({
      [`PUT ${PLAN_PATH}`]: [
        ok({ command_id: "cmd-1", disposition_code: "PLAN_ALREADY_ADMITTED" }),
      ],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("PLAN_ALREADY_ADMITTED");
  });

  it("a plan refused with 200 by the preview exits 5 and applies nothing", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [
        ok({ status: "refused", disposition_code: "BACKLOG_STAGE_REQUIRED" }),
      ],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file, "--apply");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("BACKLOG_STAGE_REQUIRED");
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("a plan refused with 200 on the status route while waiting exits 5", async () => {
    const { ctx } = await setup({
      [`PUT ${PLAN_PATH}`]: [ok(applyResult("applying"), 202)],
      [`GET ${STATUS_PATH}`]: [
        ok({
          command_id: "cmd-1",
          status: "refused",
          disposition_code: "WORKSPACE_MUTATION_ACTIVE",
        }),
      ],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("WORKSPACE_MUTATION_ACTIVE");
  });

  it("a plan refused with 200 as a stale preview exits 6 and says to preview again", async () => {
    const { ctx } = await setup({
      [`PUT ${PLAN_PATH}`]: [ok({ status: "refused", disposition_code: "PREVIEW_STALE" })],
    });
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--apply",
      "--digest",
      "sha256:old",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
    expect(body.error?.details["next"]).toMatch(/Preview again/);
  });
});

/** A brief as the contract states it: type brief, tier stage, 1-8192 characters of content. */
const BRIEF = {
  type: "brief",
  tier: "stage",
  content: "Files: src/a.ts. Pattern: copy src/b.ts. Narrowest test: tests/a.test.ts.",
};
const MAX_BRIEF = 8192;

/** Two new children and two kept ones; the briefs sit on some, and one kept child clears its own. */
const BRIEF_PLAN = {
  ...MIXED_PLAN,
  children: [
    { ...MIXED_PLAN.children[0], context_artifacts: [BRIEF] },
    {
      ...MIXED_PLAN.children[1],
      context_artifacts: [
        { ...BRIEF, content: "Replace the stored brief.", reference_url: "https://example.com/b" },
        { ...BRIEF, content: "A second brief." },
        { ...BRIEF, content: "A third brief." },
      ],
    },
    { ...MIXED_PLAN.children[2] },
    { ...MIXED_PLAN.children[3], context_artifacts: [] },
  ],
};

describe("pidgen plan apply: child briefs", () => {
  /** The first child of a plan as the server must receive it, in the preview and the apply. */
  function sentChildren(calls: Call[]) {
    const plans = calls.map((call) => (call.body as { plan: { children: unknown[] } }).plan);
    return plans.map((plan) => plan.children);
  }

  it.each(["json", "yaml"])(
    "%s: context_artifacts are sent unchanged in the preview and in the apply, new and kept children alike",
    async (format) => {
      const { ctx, calls } = await setup({
        [`POST ${PREVIEW_PATH}`]: [ok({ ...preview(), plan: BRIEF_PLAN })],
        [`PUT ${PLAN_PATH}`]: [ok(applyResult())],
      });
      const name = `briefs.${format}`;
      await writeFile(
        join(ctx.cwd, name),
        format === "yaml" ? stringify(BRIEF_PLAN) : JSON.stringify(BRIEF_PLAN),
      );
      const expected = JSON.parse(JSON.stringify(BRIEF_PLAN)) as typeof BRIEF_PLAN;
      const previewed = await run(ctx, "plan", "apply", ROOT, "-f", name);
      expect(previewed.code).toBe(ExitCode.Ok);
      const applied = await run(
        ctx,
        "plan",
        "apply",
        ROOT,
        "-f",
        name,
        "--apply",
        "--digest",
        "sha256:preview-1",
      );
      expect(applied.code).toBe(ExitCode.Ok);
      expect(calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", PREVIEW_PATH],
        ["PUT", PLAN_PATH],
      ]);
      expect(calls[0]?.body).toEqual({ plan: expected });
      expect((calls[1]?.body as { plan: unknown }).plan).toEqual(expected);
      for (const children of sentChildren(calls)) {
        expect(children).toEqual(expected.children);
        // Absent stays absent (no field is added), and an empty list stays an empty list.
        expect(children[2]).not.toHaveProperty("context_artifacts");
        expect(children[3]).toHaveProperty("context_artifacts", []);
      }
    },
  );

  it("brief_file is read relative to the plan file and sent as one brief item, in the preview and the apply", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview())],
      [`PUT ${PLAN_PATH}`]: [ok(applyResult())],
    });
    await mkdir(join(ctx.cwd, "plans", "briefs"), { recursive: true });
    await mkdir(join(ctx.cwd, "briefs"));
    const text = "# Brief\nChange src/a.ts, copy src/b.ts. Naïve café ✓\n";
    await writeFile(join(ctx.cwd, "plans", "briefs", "first.md"), text);
    // The same name beside the working directory must not be the one read.
    await writeFile(join(ctx.cwd, "briefs", "first.md"), "wrong file");
    const plan = {
      ...PLAN,
      children: [
        { ...PLAN.children[0], brief_file: "briefs/first.md" },
        { ...PLAN.children[1] },
        { ...MIXED_PLAN.children[1], brief_file: "./briefs/first.md" },
      ],
    };
    await writeFile(join(ctx.cwd, "plans", "plan.json"), JSON.stringify(plan));
    const previewed = await run(ctx, "plan", "apply", ROOT, "-f", "plans/plan.json");
    expect(previewed.code).toBe(ExitCode.Ok);
    const applied = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      "plans/plan.json",
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(applied.code).toBe(ExitCode.Ok);
    const item = [{ type: "brief", tier: "stage", content: text }];
    for (const children of sentChildren(calls)) {
      expect(children).toEqual([
        { ...PLAN.children[0], context_artifacts: item },
        PLAN.children[1],
        JSON.parse(JSON.stringify({ ...MIXED_PLAN.children[1], context_artifacts: item })),
      ]);
      for (const child of children as Record<string, unknown>[]) {
        expect(child).not.toHaveProperty("brief_file");
      }
    }
  });

  it("brief_file of a plan read from standard input is relative to the working directory", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    await writeFile(join(ctx.cwd, "brief.md"), "From the working directory.");
    const plan = { children: [{ ...PLAN.children[0], brief_file: "brief.md" }] };
    ctx.readStdin = () => Promise.resolve(JSON.stringify(plan));
    const { code } = await run(ctx, "plan", "apply", ROOT, "-f", "-");
    expect(code).toBe(ExitCode.Ok);
    expect(sentChildren(calls)[0]).toEqual([
      {
        ...PLAN.children[0],
        context_artifacts: [
          { type: "brief", tier: "stage", content: "From the working directory." },
        ],
      },
    ]);
  });

  it("a brief_file of exactly 8192 characters is sent; counted in characters, not bytes", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const content = "é".repeat(MAX_BRIEF);
    await writeFile(join(ctx.cwd, "brief.md"), content);
    const plan = { children: [{ ...PLAN.children[0], brief_file: "brief.md" }] };
    await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
    const { code } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json");
    expect(code).toBe(ExitCode.Ok);
    const sent = sentChildren(calls)[0] as { context_artifacts: { content: string }[] }[];
    expect(sent[0]?.context_artifacts[0]?.content).toHaveLength(MAX_BRIEF);
  });

  it.each([
    ["is missing", async () => undefined, /missing\.md/],
    ["is empty", async (dir: string) => writeFile(join(dir, "missing.md"), ""), /empty/],
    [
      "is over 8192 characters",
      async (dir: string) => writeFile(join(dir, "missing.md"), "x".repeat(MAX_BRIEF + 1)),
      /8192/,
    ],
    [
      "is over 8192 characters in multi-byte text",
      async (dir: string) => writeFile(join(dir, "missing.md"), "é".repeat(MAX_BRIEF + 1)),
      /8192/,
    ],
    [
      "is far larger than any brief",
      async (dir: string) => writeFile(join(dir, "missing.md"), "x".repeat(1_000_000)),
      /8192/,
    ],
    [
      "is a directory",
      async (dir: string) => mkdir(join(dir, "missing.md")),
      /not a file|missing\.md/,
    ],
  ] as const)(
    "a brief_file that %s is a usage error (exit 2, INPUT_INVALID at the child) and nothing is sent",
    async (_, arrange, message) => {
      for (const flags of [[], ["--apply", "--digest", "sha256:preview-1"]]) {
        const { ctx, calls } = await setup();
        await arrange(ctx.cwd);
        const plan = {
          children: [PLAN.children[0], { ...PLAN.children[1], brief_file: "missing.md" }],
        };
        await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
        const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json", ...flags);
        expect(code).toBe(ExitCode.Usage);
        expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
        expect(body.error?.details["issues"]).toEqual([
          expect.objectContaining({
            path: "$.children[1].brief_file",
            message: expect.stringMatching(message),
          }),
        ]);
        expect(calls).toHaveLength(0);
      }
    },
  );

  it.each([[42], [""], [null], [["brief.md"]], [{ path: "brief.md" }]])(
    "a brief_file of %j is a usage error and nothing is sent",
    async (brief_file) => {
      const { ctx, calls } = await setup();
      const plan = { children: [{ ...PLAN.children[0], brief_file }] };
      await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
      const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json");
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("INPUT_INVALID");
      expect(body.error?.details["issues"]).toEqual([
        expect.objectContaining({ path: "$.children[0].brief_file" }),
      ]);
      expect(calls).toHaveLength(0);
    },
  );

  it("a child naming both brief_file and context_artifacts is a usage error and nothing is sent", async () => {
    const { ctx, calls } = await setup();
    await writeFile(join(ctx.cwd, "brief.md"), "A brief.");
    const plan = {
      children: [{ ...PLAN.children[0], brief_file: "brief.md", context_artifacts: [BRIEF] }],
    };
    await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    expect(body.error?.details["issues"]).toEqual([
      expect.objectContaining({ path: "$.children[0].brief_file" }),
    ]);
    expect(body.error?.message).toMatch(/1 issue/);
    expect(calls).toHaveLength(0);
  });

  it("every problem in the plan is reported together: the schema's, a team_member_id and each brief_file", async () => {
    const { ctx, calls } = await setup();
    const plan = {
      children: [
        { ...PLAN.children[0], team_member_id: null, brief_file: "gone-1.md" },
        {
          ...PLAN.children[1],
          brief_file: "gone-2.md",
          context_artifacts: [{ ...BRIEF, type: "x" }],
        },
      ],
    };
    await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json");
    expect(code).toBe(ExitCode.Usage);
    const paths = (body.error?.details["issues"] as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "$.children[0].team_member_id",
        "$.children[0].brief_file",
        "$.children[1].brief_file",
        expect.stringMatching(/^\$\.children\[1\]\.context_artifacts\[0\]/),
      ]),
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["another type", { context_artifacts: [{ ...BRIEF, type: "incident_link" }] }],
    ["another tier", { context_artifacts: [{ ...BRIEF, tier: "reference" }] }],
    ["no tier", { context_artifacts: [{ type: "brief", content: "A brief." }] }],
    ["no content", { context_artifacts: [{ type: "brief", tier: "stage" }] }],
    ["empty content", { context_artifacts: [{ ...BRIEF, content: "" }] }],
    [
      "content over 8192 characters",
      { context_artifacts: [{ ...BRIEF, content: "x".repeat(MAX_BRIEF + 1) }] },
    ],
    ["a fourth item", { context_artifacts: [BRIEF, BRIEF, BRIEF, BRIEF] }],
    ["a non-array value", { context_artifacts: BRIEF }],
    [
      "a reference_url that is not a string",
      { context_artifacts: [{ ...BRIEF, reference_url: 5 }] },
    ],
  ])(
    "context_artifacts with %s is refused as INPUT_INVALID (exit 2) before any request",
    async (_, extra) => {
      for (const flags of [[], ["--apply", "--digest", "sha256:preview-1"]]) {
        const { ctx, calls } = await setup();
        const plan = { children: [{ ...PLAN.children[0], ...extra }] };
        await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
        const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json", ...flags);
        expect(code).toBe(ExitCode.Usage);
        expect(body).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
        const issues = body.error?.details["issues"] as { path: string }[];
        expect(issues.length).toBeGreaterThan(0);
        expect(
          issues.every((issue) => issue.path.startsWith("$.children[0].context_artifacts")),
        ).toBe(true);
        expect(calls).toHaveLength(0);
      }
    },
  );

  it("a server refusal of a brief keeps its code: 422 INPUT_INVALID exits 2 and the plan is not sent again", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [
        refusal(422, "INPUT_INVALID", "The request failed validation.", {
          errors: [{ loc: ["body", "plan", "children", 0, "context_artifacts"], msg: "unknown" }],
        }),
      ],
    });
    const plan = { children: [{ ...PLAN.children[0], context_artifacts: [BRIEF] }] };
    await writeFile(join(ctx.cwd, "plan.json"), JSON.stringify(plan));
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(calls).toHaveLength(1);
  });

  it("the template documents both forms of a brief and stays a plan plan apply accepts", () => {
    expect(PLAN_TEMPLATE_YAML).toMatch(/^\s*# context_artifacts:/m);
    expect(PLAN_TEMPLATE_YAML).toMatch(/^\s*# brief_file: /m);
    expect(PLAN_TEMPLATE_YAML).toContain("relative to this file");
    expect(PLAN_TEMPLATE_YAML).toContain("8192");
    const plan = parse(PLAN_TEMPLATE_YAML) as { children: Record<string, unknown>[] };
    for (const child of plan.children) {
      expect(child).not.toHaveProperty("brief_file");
      expect(child).not.toHaveProperty("context_artifacts");
    }
  });
});

describe("pidgen plan template", () => {
  it("template writes a file that plan apply accepts", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview())],
      [`PUT ${PLAN_PATH}`]: [ok(applyResult())],
    });
    const written = await run(ctx, "plan", "template");
    expect(written.code).toBe(ExitCode.Ok);
    expect(written.body).toMatchObject({
      ok: true,
      data: { path: "child-plan.yaml", format: "yaml" },
    });
    expect(calls).toHaveLength(0);

    const text = await readFile(join(ctx.cwd, "child-plan.yaml"), "utf8");
    expect(text).toMatch(/^# /m);
    const plan = parse(text) as Record<string, unknown>;
    expect(() => validateBody(PUBLIC_API_DOCUMENT, "post", PREVIEW_PATH, { plan })).not.toThrow();

    const previewed = await run(ctx, "plan", "apply", ROOT, "-f", "child-plan.yaml");
    expect(previewed.code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ plan });

    const applied = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      "child-plan.yaml",
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(applied.code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({ plan, preview_digest: "sha256:preview-1" });
  });

  it("template writes JSON for a .json output, which plan apply accepts", async () => {
    const { ctx } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const written = await run(ctx, "plan", "template", "-o", "plan.json");
    expect(written.body.data).toEqual({ path: "plan.json", format: "json" });
    const plan = JSON.parse(await readFile(join(ctx.cwd, "plan.json"), "utf8")) as unknown;
    expect(plan).toMatchObject({ children: [{ key: "first-slice" }, { key: "follow-up" }] });
    const previewed = await run(ctx, "plan", "apply", ROOT, "-f", "plan.json");
    expect(previewed.code).toBe(ExitCode.Ok);
  });

  it("template refuses to overwrite a file without --force, and overwrites with it", async () => {
    const { ctx } = await setup();
    await writeFile(join(ctx.cwd, "child-plan.yaml"), "keep me\n");
    const refused = await run(ctx, "plan", "template");
    expect(refused.code).toBe(ExitCode.Refused);
    expect(refused.body).toMatchObject({ ok: false, error: { code: "FILE_EXISTS" } });
    expect(await readFile(join(ctx.cwd, "child-plan.yaml"), "utf8")).toBe("keep me\n");

    const forced = await run(ctx, "plan", "template", "--force");
    expect(forced.code).toBe(ExitCode.Ok);
    expect(await readFile(join(ctx.cwd, "child-plan.yaml"), "utf8")).toMatch(/children:/);
  });

  it("template usage: an unknown option exits 2", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "plan", "template", "--bogus");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
  });
});

describe("pidgen plan: usage errors", () => {
  it("usage: plan apply without -f exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "plan", "apply", ROOT);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toMatch(/--file/);
    expect(calls).toHaveLength(0);
  });

  it("usage: plan apply without a root exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const file = await writePlan(ctx);
    const { code, body } = await run(ctx, "plan", "apply", "-f", file);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("usage: plan apply --digest without --apply exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const file = await writePlan(ctx);
    const { code, body } = await run(
      ctx,
      "plan",
      "apply",
      ROOT,
      "-f",
      file,
      "--digest",
      "sha256:x",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("usage: a plan that does not match the schema exits 2 with INPUT_INVALID at its place in the file", async () => {
    const { ctx, calls } = await setup();
    const file = await writePlan(ctx, { children: [{ key: "a", title: "A" }] });
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", file);
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    const issues = body.error?.details["issues"] as { path: string }[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.path.startsWith("$.children[0]"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("usage: a missing plan file exits 2 with INPUT_INVALID", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "plan", "apply", ROOT, "-f", "missing.yaml");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("usage: plan show without a root exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "plan", "show");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("usage: a root that is not a ticket reference exits 2 and reaches no other route", async () => {
    const { ctx, calls } = await setup();
    for (const root of ["..", "PIDGEN-4/../admin", "a b"]) {
      const { code, body } = await run(ctx, "plan", "show", root);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
    }
    expect(calls).toHaveLength(0);
  });

  it("usage: plan show with nothing configured exits 3 with AUTH_REQUIRED", async () => {
    const { ctx, calls } = await setup({}, null);
    const { code, body } = await run(ctx, "plan", "show", ROOT);
    expect(code).toBe(ExitCode.Auth);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(calls).toHaveLength(0);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: plan show at %s columns", async (columns) => {
  const { ctx, calls } = await setup({
    [`GET ${PLAN_PATH}`]: [ok(CURRENT_PLAN), ok(CURRENT_PLAN)],
  });
  ctx.io.stdoutColumns = columns;
  const argv = ["plan", "show", ROOT];
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
    "Child plan",
    "Ticket version: 7",
    "Materialized plan digest",
    "sha256:plan-current",
    "Items (0 displayed)",
    "Validation findings (0 displayed)",
  ])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

it.each([40, 80, 120])(
  "plan preview retains the digest and plan without applying at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview()), ok(preview())],
    });
    ctx.io.stdoutColumns = columns;
    const file = await writePlan(ctx);
    const json = await expectMutationParity(
      ctx,
      calls,
      ["plan", "apply", ROOT, "-f", file],
      ["Preview — not applied.", "sha256:preview-1", "First slice"],
    );
    expect(json.ok).toBe(true);
    expect(calls).toHaveLength(1);
  },
);
