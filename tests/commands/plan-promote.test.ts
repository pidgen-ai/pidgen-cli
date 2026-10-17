import { expectMutationParity } from "../support/context.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import { envelope, jsonResponse, testContext, type TestContext } from "../support/context.js";

const SERVER = "https://pidgen.example.com";
const TOKEN = "pidgen_pat_fake_token_for_tests";
const ROOT = "PIDGEN-4";
const PROMOTION_PATH = `/api/v1/tickets/${ROOT}/promotion`;
const PREVIEW_PATH = `${PROMOTION_PATH}/preview`;
const STATUS_PATH = `${PROMOTION_PATH}/applications/cmd-1`;

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

const PASSING_GATE = {
  gate: "materialized_plan_current",
  passed: true,
  reason: "The child plan is current.",
  repair_target: null,
};

const FAILING_GATE = {
  gate: "ticket:tkt-example-child:execution_readiness",
  passed: false,
  reason: "The child has no acceptance criteria.",
  repair_target: "PIDGEN-6",
};

function preview(failing: object[] = []) {
  return {
    plan: {
      root_ticket_id: "tkt-example-root",
      ticket_version: 7,
      backlog_disposition: "promote",
      is_composition_parent: true,
      covered_children: [
        {
          ticket_id: "tkt-example-child",
          version: 2,
          team_member_id: "tm-example",
          config_digest: "sha256:config",
          ready: failing.length === 0,
        },
      ],
      dependencies: [],
      materialized_plan_digest: "sha256:plan-current",
      releases_count: 1,
    },
    preview_digest: "sha256:preview-1",
    required_acknowledgements: [],
    passed: failing.length === 0,
    gate_results: [PASSING_GATE, ...failing],
    failing_gates: failing,
  };
}

function applyResult(status: "applied" | "applying" = "applied") {
  const applied = status === "applied";
  return {
    command_id: "cmd-1",
    status,
    status_url: `${SERVER}${STATUS_PATH}`,
    root_ticket_id: "tkt-example-root",
    ticket_version: applied ? 8 : null,
    execution_admission_digest: applied ? "sha256:preview-1" : null,
    materialized_plan_digest: "sha256:plan-current",
    releases_count: 1,
    covered_ticket_ids: ["tkt-example-child"],
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
async function setup(
  routes: Record<string, Response[]> = {},
  config: Config | null = CONFIG,
  interactive = false,
) {
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
  if (interactive) ctx.io = { ...ctx.io, interactive: true };
  if (config) await saveConfig(ctx, config);
  return { ctx, calls };
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

const routeOf = (call: Call) => `${call.method} ${call.path}`;

describe("pidgen plan promote: preview and its gates", () => {
  it("preview lists every gate and passes when no gates fail, changing nothing", async () => {
    const { ctx, calls } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(preview())] });
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        preview_digest: "sha256:preview-1",
        required_acknowledgements: [],
        passed: true,
        gate_results: [PASSING_GATE],
        failing_gates: [],
        plan: { releases_count: 1, materialized_plan_digest: "sha256:plan-current" },
      },
      meta: { request_id: "req-example", profile: "default", account: "ACC-EXAMPLE" },
    });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("preview lists each failing gate with its reason and repair target, and exits 0", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview([FAILING_GATE]))],
    });
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ passed: false, failing_gates: [FAILING_GATE] });
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
    expect(ctx.err).toEqual([]);
  });

  it("preview on a terminal also lists the failing gates on standard error", async () => {
    const { ctx } = await setup(
      { [`POST ${PREVIEW_PATH}`]: [ok(preview([FAILING_GATE]))] },
      CONFIG,
      true,
    );
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data?.["failing_gates"]).toEqual([FAILING_GATE]);
    const stderr = ctx.err.join("");
    expect(stderr).toContain("1 failing promotion gate");
    expect(stderr).toContain(FAILING_GATE.gate);
    expect(stderr).toContain("repair PIDGEN-6");
  });

  it("preview without its gates is an unexpected response and exits 1", async () => {
    const incomplete: Record<string, unknown> = preview();
    delete incomplete["failing_gates"];
    const { ctx } = await setup({ [`POST ${PREVIEW_PATH}`]: [ok(incomplete)] });
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "UNEXPECTED_RESPONSE" } });
  });
});

describe("pidgen plan promote --apply", () => {
  it("apply with the digest promotes, sending that digest and a derived idempotency key", async () => {
    const { ctx, calls } = await setup({ [`POST ${PROMOTION_PATH}`]: [ok(applyResult())] });
    const { code, body } = await run(
      ctx,
      "plan",
      "promote",
      ROOT,
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--reason",
      "Start the cohort",
    );
    expect(code).toBe(ExitCode.Ok);
    const key = deriveIdempotencyKey(
      { command: "plan promote", target: ROOT },
      "sha256:preview-1",
      [],
    );
    expect(calls.map(routeOf)).toEqual([`POST ${PROMOTION_PATH}`]);
    expect(calls[0]?.body).toEqual({
      preview_digest: "sha256:preview-1",
      idempotency_key: key,
      acknowledgements: [],
      reason: "Start the cohort",
    });
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        settled: true,
        idempotency_key: key,
        result: {
          status: "applied",
          ticket_version: 8,
          execution_admission_digest: "sha256:preview-1",
          covered_ticket_ids: ["tkt-example-child"],
        },
      },
      meta: { request_id: "req-example" },
    });
    expect(body.data).not.toHaveProperty("handle");
  });

  it("apply follows the application's status route after a 202 until it settles", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PROMOTION_PATH}`]: [ok(applyResult("applying"), 202)],
      [`GET ${STATUS_PATH}`]: [ok(applyResult("applying"), 202), ok(applyResult())],
    });
    const { code, body } = await run(
      ctx,
      "plan",
      "promote",
      ROOT,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([
      `POST ${PROMOTION_PATH}`,
      `GET ${STATUS_PATH}`,
      `GET ${STATUS_PATH}`,
    ]);
    expect(body.data).toMatchObject({
      settled: true,
      result: { status: "applied", ticket_version: 8 },
    });
  });

  it("apply with --no-wait returns the applying result and its status route", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PROMOTION_PATH}`]: [ok(applyResult("applying"), 202)],
    });
    const { code, body } = await run(
      ctx,
      "plan",
      "promote",
      ROOT,
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--no-wait",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      settled: false,
      handle: STATUS_PATH,
      result: { status: "applying" },
    });
    expect(calls).toHaveLength(1);
  });

  it("apply alone previews, then applies the digest of a preview whose gates all pass", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview())],
      [`POST ${PROMOTION_PATH}`]: [ok(applyResult())],
    });
    const { code, body } = await run(ctx, "plan", "promote", ROOT, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`, `POST ${PROMOTION_PATH}`]);
    expect(calls[1]?.body).toMatchObject({ preview_digest: "sha256:preview-1" });
    expect(body.data).toMatchObject({ settled: true, result: { status: "applied" } });
  });

  it("apply of a stale preview exits 6 with PREVIEW_STALE and says what to do next", async () => {
    const { ctx } = await setup({
      [`POST ${PROMOTION_PATH}`]: [
        refusal(409, "PREVIEW_STALE", "The promotion decision changed since the preview."),
      ],
    });
    const { code, body } = await run(
      ctx,
      "plan",
      "promote",
      ROOT,
      "--apply",
      "--digest",
      "sha256:old",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "PREVIEW_STALE" } });
    expect(body.error?.details["next"]).toMatch(/Preview again/);
  });
});

describe("pidgen plan promote: a refused promotion", () => {
  it("a promotion refused for a failing gate exits 5 with PROMOTION_GATE_FAILED and its gate results", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PROMOTION_PATH}`]: [
        refusal(409, "PROMOTION_GATE_FAILED", "A promotion gate failed.", {
          gate_results: [PASSING_GATE, FAILING_GATE],
        }),
      ],
    });
    const { code, body } = await run(
      ctx,
      "plan",
      "promote",
      ROOT,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "PROMOTION_GATE_FAILED",
        details: {
          status: 409,
          request_id: "req-example",
          gate_results: [PASSING_GATE, FAILING_GATE],
        },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("apply alone is refused for a failing gate in its preview: exits 5 and applies nothing", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview([FAILING_GATE]))],
    });
    const { code, body } = await run(ctx, "plan", "promote", ROOT, "--apply");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "PROMOTION_GATE_FAILED", details: { failing_gates: [FAILING_GATE] } },
    });
    expect(body.error?.message).toContain(FAILING_GATE.gate);
    expect(calls.map(routeOf)).toEqual([`POST ${PREVIEW_PATH}`]);
  });

  it("a promotion refused while waiting on the status route exits 5", async () => {
    const { ctx } = await setup({
      [`POST ${PROMOTION_PATH}`]: [ok(applyResult("applying"), 202)],
      [`GET ${STATUS_PATH}`]: [
        refusal(409, "PROMOTION_GATE_FAILED", "A promotion gate failed.", {
          gate_results: [FAILING_GATE],
          command_id: "cmd-1",
        }),
      ],
    });
    const { code, body } = await run(
      ctx,
      "plan",
      "promote",
      ROOT,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "PROMOTION_GATE_FAILED",
      details: { command_id: "cmd-1" },
    });
  });

  it("a preview refused for a ticket that is not in the Backlog exits 5 with the server's code", async () => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [
        refusal(409, "BACKLOG_STAGE_REQUIRED", "The Ticket is not in the Backlog."),
      ],
    });
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "BACKLOG_STAGE_REQUIRED", details: { status: 409 } },
    });
    expect(calls).toHaveLength(1);
  });

  it("a promotion of an unknown ticket exits 4 with TICKET_NOT_FOUND", async () => {
    const { ctx } = await setup({
      [`POST ${PREVIEW_PATH}`]: [refusal(404, "TICKET_NOT_FOUND", "No such Ticket.")],
    });
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("TICKET_NOT_FOUND");
  });
});

describe("pidgen plan promote: usage errors", () => {
  it("usage: plan promote without a root exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "plan", "promote");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: plan promote --digest without --apply exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "plan", "promote", ROOT, "--digest", "sha256:x");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });

  it("usage: a root that is not a ticket reference exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    for (const root of ["..", "PIDGEN-4/../admin", "a b"]) {
      const { code, body } = await run(ctx, "plan", "promote", root);
      expect(code).toBe(ExitCode.Usage);
      expect(body.error?.code).toBe("CLI_USAGE");
    }
    expect(calls).toHaveLength(0);
  });

  it("usage: an unknown option exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "plan", "promote", ROOT, "--force");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("usage: plan promote with nothing configured exits 3 with AUTH_REQUIRED", async () => {
    const { ctx, calls } = await setup({}, null);
    const { code, body } = await run(ctx, "plan", "promote", ROOT);
    expect(code).toBe(ExitCode.Auth);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
    expect(calls).toHaveLength(0);
  });
});

it.each([40, 80, 120])(
  "promotion gates and repair targets preserve streams at %s columns",
  async (columns) => {
    const { ctx, calls } = await setup({
      [`POST ${PREVIEW_PATH}`]: [ok(preview([FAILING_GATE])), ok(preview([FAILING_GATE]))],
    });
    ctx.io.stdoutColumns = columns;
    const json = await expectMutationParity(
      ctx,
      calls,
      ["plan", "promote", ROOT],
      ["Preview — not applied.", FAILING_GATE.gate, FAILING_GATE.repair_target, "Repair blockers"],
    );
    expect(json.ok).toBe(true);
    expect(ctx.err.join("")).toContain(FAILING_GATE.reason);
    expect(calls).toHaveLength(1);
  },
);
