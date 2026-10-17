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

function ticket(n: number, stage = "specification") {
  return {
    ticket_id: `TKT-example-${n}`,
    ticket_key: `ALPHA-${n}`,
    title: `Ticket ${n}`,
    stage,
    project_id: "proj-example",
  };
}

/** Tickets parked on a clarification, and tickets whose run failed. */
const WAITING = {
  clarification_needed: [ticket(7), ticket(4)],
  execution_failed: [ticket(9, "failed")],
} as Record<string, unknown[]>;

/**
 * One attention finding as the published contract states it. A finding has no `action` field; what
 * can be done is in its `actions`, the decisions for its `target`.
 */
function finding(n: number, overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: `TKT-example-${n}`,
    ticket_key: `ALPHA-${n}`,
    title: `Ticket ${n}`,
    stage: "completed",
    project_id: "proj-example",
    parent_ticket_id: null,
    code: "completed_without_delivery",
    severity: "error",
    detail: "The ticket completed but no delivery proves it.",
    run_id: null,
    session_id: null,
    node_id: null,
    first_detected_at: `2026-09-2${n}T08:00:00Z`,
    last_seen_at: "2026-09-27T08:00:00Z",
    cause_code: null,
    effect_safety: null,
    recovery_reason: null,
    workflow_attention: null,
    addressee: { kind: "owner", user_id: null },
    claim: null,
    decision_key: null,
    label: null,
    review_item: null,
    related_records: [],
    fan_out_key: null,
    delivery_count: null,
    revision: null,
    hold_state: null,
    hold_until: null,
    question: null,
    command_id: null,
    prerequisite_id: null,
    live_run_hold: null,
    target: null,
    actions: [],
    ...overrides,
  };
}

/** One action decision on a finding's target, as the Ticket actions contract states it. */
function action(
  kind: string,
  label: string,
  target: { ticket: number; run?: string; node?: string },
  options: {
    recommended?: string;
    refusal?: { code: string; message: string; instead: string | null };
  } = {},
) {
  return {
    action: kind,
    family: "recovery",
    label,
    target: {
      kind: target.node !== undefined ? "node" : target.run !== undefined ? "run" : "ticket",
      ticket_id: `TKT-example-${target.ticket}`,
      run_id: target.run ?? null,
      node_id: target.node ?? null,
      fan_out_key: null,
    },
    admissible: { allowed: options.refusal === undefined, refusal: options.refusal ?? null },
    authorized: { allowed: true, refusal: null },
    recommended: options.recommended !== undefined ? { reason: options.recommended } : null,
    consequence: { run: "continue", inputs: [] },
    requires_preview: true,
  };
}

const PARKED = { ticket: 2, run: "WFR-example-2", node: "implement" };

/**
 * In the server's order: findings with a recommended action first, then the oldest — so the two
 * findings recommending nothing come last although they were detected first.
 */
const QUEUE = {
  findings: [
    finding(1, {
      label: "Reopen for delivery",
      target: {
        kind: "ticket",
        ticket_id: "TKT-example-1",
        run_id: null,
        node_id: null,
        fan_out_key: null,
      },
      actions: [
        action(
          "reopen_for_delivery",
          "Reopen for delivery",
          { ticket: 1 },
          {
            recommended: "No delivery proves the completion.",
          },
        ),
      ],
    }),
    finding(2, {
      stage: "in_execution",
      code: "node_parked",
      run_id: "WFR-example-2",
      node_id: "implement",
      effect_safety: "safe_to_repeat",
      recovery_reason: "worker_lost",
      label: "Recover the parked node",
      target: {
        kind: "node",
        ticket_id: "TKT-example-2",
        run_id: "WFR-example-2",
        node_id: "implement",
        fan_out_key: null,
      },
      actions: [
        action("retry_run", "Retry the run", { ticket: 2, run: "WFR-example-2" }),
        action("recover_parked_node", "Recover the parked node", PARKED, {
          recommended: "The node's effects are safe to repeat.",
        }),
        action("replay_from_node", "Replay from this node", PARKED, {
          refusal: {
            code: "REPLAY_REQUIRES_PRODUCER",
            message: "Replay the producer node instead.",
            instead: "replay_from_node",
          },
        }),
      ],
    }),
    finding(3, {
      stage: "implementation_ready",
      code: "workspace_admission_failed",
      cause_code: "clone_failed",
      first_detected_at: "2026-09-18T08:00:00Z",
    }),
    finding(4, {
      code: "delivery_unverifiable",
      severity: "warning",
      first_detected_at: "2026-09-19T08:00:00Z",
    }),
  ],
  open_count: 4,
  ticket_count: 4,
  swept_at: "2026-09-27T08:00:00Z",
};

/** What `pidgen review attention` prints: each finding with its `recommended_action` (or null). */
function shown<T extends { findings: Record<string, unknown>[] }>(queue: T) {
  return {
    ...queue,
    findings: queue.findings.map((f) => {
      const actions = (f["actions"] ?? []) as ReturnType<typeof action>[];
      const recommended = actions.find((a) => a.recommended !== null);
      return {
        ...f,
        recommended_action:
          recommended === undefined
            ? null
            : {
                action: recommended.action,
                label: recommended.label,
                reason: recommended.recommended?.reason,
                target: recommended.target,
                state: "allowed",
                refusal: null,
              },
      };
    }),
  };
}

function ok(data: unknown, requestId: string) {
  return jsonResponse(
    200,
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

/** Answers `GET /tickets?intervention=…` and `GET /attention`. */
function server(call: Call): Response {
  if (call.method !== "GET") return publicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  if (call.url.pathname === "/api/v1/tickets") {
    const type = call.url.searchParams.get("intervention") ?? "";
    return ok(WAITING[type] ?? [], "req_fake_list");
  }
  if (call.url.pathname === "/api/v1/attention") return ok(QUEUE, "req_fake_attention");
  return publicError(404, "NOT_FOUND", "No such route.");
}

async function setup(options: { respond?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  const respond = options.respond ?? server;
  const ctx = await testContext({
    fetch: (input, init) => {
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
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

function query(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(call?.url.searchParams ?? []);
}

describe("pidgen review list", () => {
  it("list returns the tickets with an open clarification_needed intervention by default", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "review", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: WAITING["clarification_needed"],
      error: null,
      meta: { ...META, request_id: "req_fake_list" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/api/v1/tickets");
    expect(query(calls[0])).toEqual({
      intervention: "clarification_needed",
      page: "1",
      per_page: "100",
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("list --type returns the tickets with an open intervention of that type", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "review", "list", "--type", "execution_failed");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: WAITING["execution_failed"], error: null });
    expect(query(calls[0])).toMatchObject({ intervention: "execution_failed" });
  });

  it("list follows every page of the intervention's tickets", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ticket(100 + i));
    const { ctx, calls } = await setup({
      respond: (call) =>
        ok(call.url.searchParams.get("page") === "1" ? full : [ticket(1)], "req_fake_page"),
    });
    const { code, body } = await run(ctx, "review", "list");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toHaveLength(101);
    expect(calls.map((call) => query(call))).toEqual([
      { intervention: "clarification_needed", page: "1", per_page: "100" },
      { intervention: "clarification_needed", page: "2", per_page: "100" },
    ]);
  });

  it("list with no waiting tickets returns an empty array", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "review", "list", "--type", "review_required");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: [], error: null });
  });

  it("list refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not list tickets."),
    });
    const { code, body } = await run(ctx, "review", "list");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "FORBIDDEN",
        message: "You may not list tickets.",
        details: { status: 403, request_id: "req_fake_error" },
      },
    });
  });

  it("list refused by the server as invalid input (422) exits 2 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "INPUT_INVALID", "The request failed validation."),
    });
    const { code, body } = await run(ctx, "review", "list");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "INPUT_INVALID" } });
  });

  it.each([
    ["an unknown type", ["review", "list", "--type", "waiting"]],
    ["--type without a value", ["review", "list", "--type"]],
    ["an argument", ["review", "list", "ALPHA-2"]],
  ])("usage: list with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

/** A decision follow-up as the contract states it, here a hold waiting for its review. */
const HOLD_REVIEW = {
  decision_key: "decision-example",
  kind: "hold_review",
  step: "review_due",
  summary: "The hold on the payment decision is due for review.",
  waiting_on: { user_id: "user-reviewer", display_name: "Example Reviewer" },
  owner: { user_id: "user-example", display_name: "Example Owner" },
  delegated_by: null,
  escalated_to: [{ user_id: "user-manager", display_name: "Example Manager", tier: "manager" }],
  asked_at: "2026-09-20T08:00:00Z",
  next: { step: "review", at: "2026-10-05T08:00:00Z" },
  hold_at: "2026-09-27T08:00:00Z",
  deferred_until: null,
  deferral_count: 0,
  defer_latest: "2026-10-27T08:00:00Z",
  viewer_snoozed_until: null,
  time_zone: "Europe/Amsterdam",
  hold_id: "hold-example",
};

const HOLD = {
  hold_id: "hold-example",
  ticket_id: "TKT-example-1",
  scope: "decision",
  cause: { kind: "decision", decision_key: "decision-example" },
  held_ticket_ids: ["TKT-example-1", "TKT-example-2"],
  reason: "Waiting on the legal review",
  requested_by: { kind: "user", user_id: "user-example", display_name: "Example Owner" },
  state: "active",
  requested_at: "2026-09-27T08:00:00Z",
  confirmed_at: "2026-09-27T08:05:00Z",
  capacity_released_at: "2026-09-27T08:06:00Z",
  review_at: "2026-10-05T08:00:00Z",
  released_at: null,
  released_by: null,
};

/** The queue the `on_hold` view answers: the holds due for review in the caller's review scope. */
const ON_HOLD = {
  ...QUEUE,
  addressee: "on_hold",
  counts: { me: 1, claimable: 2, following: 3, all: 4, on_hold: 1 },
  review_scope: { kind: "projects", project_ids: ["proj-example"] },
  findings: [
    finding(1, {
      code: "decision_hold_review_due",
      decision_key: "decision-example",
      addressee: { kind: "reviewer", user_id: "user-reviewer" },
      followup: HOLD_REVIEW,
      hold: HOLD,
      actions: [
        action(
          "keep_holding",
          "Keep holding",
          { ticket: 1 },
          { recommended: "The hold is due for review." },
        ),
        action("proceed_on_assumption", "Proceed on the recommended answer", { ticket: 1 }),
      ],
    }),
  ],
  open_count: 1,
  ticket_count: 1,
};

describe("pidgen review attention --addressee on_hold", () => {
  it("passes the on_hold view and preserves the queue, its counts, review scope and holds", async () => {
    const { ctx, calls } = await setup({ respond: () => ok(ON_HOLD, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "on_hold");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: shown(ON_HOLD),
      error: null,
      meta: { ...META, request_id: "req_fake_attention" },
    });
    expect(query(calls[0])).toEqual({ addressee: "on_hold" });
    const data = body.data as {
      addressee: string;
      counts: Record<string, number>;
      review_scope: unknown;
      findings: Record<string, unknown>[];
    };
    expect(data.addressee).toBe("on_hold");
    expect(data.counts["on_hold"]).toBe(1);
    expect(data.review_scope).toEqual({ kind: "projects", project_ids: ["proj-example"] });
    expect(data.findings[0]).toMatchObject({
      followup: { kind: "hold_review", step: "review_due", hold_id: "hold-example" },
      hold: { hold_id: "hold-example", state: "active", scope: "decision" },
      addressee: { kind: "reviewer" },
      recommended_action: { action: "keep_holding", state: "allowed" },
    });
  });

  it("an account-wide review scope has no project ids to list", async () => {
    const queue = { ...ON_HOLD, review_scope: { kind: "account", project_ids: [] } };
    const { ctx } = await setup({ respond: () => ok(queue, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "on_hold");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ review_scope: { kind: "account", project_ids: [] } });
  });

  it("a caller with no review scope sees review_scope null and no findings", async () => {
    const queue = { ...ON_HOLD, review_scope: null, findings: [], open_count: 0, ticket_count: 0 };
    const { ctx } = await setup({ respond: () => ok(queue, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "on_hold");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ review_scope: null, findings: [], open_count: 0 });
  });

  it("without the option the request has no addressee and the queue is shown as before", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(shown(QUEUE));
    expect(calls.map((call) => call.url.search)).toEqual([""]);
    expect(query(calls[0])).toEqual({});
  });

  it("a server that does not publish the view refuses it with its own code and exits 2", async () => {
    const { ctx, calls } = await setup({
      respond: () => publicError(422, "INPUT_INVALID", "Unknown addressee."),
    });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "on_hold");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { status: 422 } },
    });
    expect(query(calls[0])).toEqual({ addressee: "on_hold" });
  });

  it("a caller who may not read the queue exits 3 with the server's code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not review holds."),
    });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "on_hold");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({ code: "FORBIDDEN", message: "You may not review holds." });
  });

  it.each([
    ["on-hold", ["review", "attention", "--addressee", "on-hold"]],
    ["ON_HOLD", ["review", "attention", "--addressee", "ON_HOLD"]],
    ["held", ["review", "attention", "--addressee", "held"]],
  ])("usage: --addressee %s is not a view and exits 2", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

describe("pidgen review attention", () => {
  it.each(["me", "claimable", "following", "all"])(
    "passes --addressee %s and preserves the server queue",
    async (addressee) => {
      const addressed = {
        ...QUEUE,
        addressee,
        counts: { me: 1, claimable: 2, following: 3, all: 4 },
        findings: QUEUE.findings.map((f) => ({
          ...f,
          decision_key: "decision-example",
          addressee: { kind: "owner", user_id: "user-example" },
          claim: { claimed_by: "user-example", claimed_at: "2026-09-27T08:00:00Z" },
        })),
        following:
          addressee === "following"
            ? [
                {
                  ...ticket(7),
                  situation: "Waiting for a decision",
                  waiting_on: { user_id: "user-example", display_name: "Example User" },
                  source: "explicit",
                },
              ]
            : [],
      };
      const { ctx, calls } = await setup({ respond: () => ok(addressed, "req_fake_attention") });
      const { code, body } = await run(ctx, "review", "attention", "--addressee", addressee);
      expect(code).toBe(ExitCode.Ok);
      expect(body).toEqual({
        ok: true,
        data: shown(addressed),
        error: null,
        meta: { ...META, request_id: "req_fake_attention" },
      });
      expect(calls).toHaveLength(1);
      expect(query(calls[0])).toEqual({ addressee });
    },
  );

  it("preserves a server refusal with an addressee", async () => {
    const { ctx } = await setup({
      respond: () => publicError(422, "INPUT_INVALID", "Unknown addressee."),
    });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "me");
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INPUT_INVALID", details: { status: 422 } },
    });
  });

  it("attention keeps the server's order — recommended actions first, then the oldest — and findings carry no action field", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: shown(QUEUE),
      error: null,
      meta: { ...META, request_id: "req_fake_attention" },
    });
    const findings = (body.data as { findings: Record<string, unknown>[] }).findings;
    expect(findings.map((f) => f["ticket_key"])).toEqual([
      "ALPHA-1",
      "ALPHA-2",
      "ALPHA-3",
      "ALPHA-4",
    ]);
    for (const f of findings) expect(f).not.toHaveProperty("action");
    const recommended = findings.map((f) => f["recommended_action"] !== null);
    expect(recommended).toEqual([true, true, false, false]);
    // Not oldest first: the findings recommending nothing were detected before the others.
    const detected = findings.map((f) => f["first_detected_at"] as string);
    expect(detected).not.toEqual([...detected].sort());
    expect(findings[1]).toMatchObject({
      label: "Recover the parked node",
      target: { kind: "node", node_id: "implement" },
      prerequisite_id: null,
    });
    expect(calls.map((call) => [call.method, call.url.pathname, call.url.search])).toEqual([
      ["GET", "/api/v1/attention", ""],
    ]);
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-pidgen-account": "ACC-EXAMPLE",
    });
  });

  it("attention shows each item's recommended action from its action decisions", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    const findings = (body.data as { findings: Record<string, unknown>[] }).findings;
    expect(findings.map((f) => [f["ticket_key"], f["recommended_action"]])).toEqual([
      [
        "ALPHA-1",
        {
          action: "reopen_for_delivery",
          label: "Reopen for delivery",
          reason: "No delivery proves the completion.",
          target: {
            kind: "ticket",
            ticket_id: "TKT-example-1",
            run_id: null,
            node_id: null,
            fan_out_key: null,
          },
          state: "allowed",
          refusal: null,
        },
      ],
      [
        "ALPHA-2",
        {
          action: "recover_parked_node",
          label: "Recover the parked node",
          reason: "The node's effects are safe to repeat.",
          target: {
            kind: "node",
            ticket_id: "TKT-example-2",
            run_id: "WFR-example-2",
            node_id: "implement",
            fan_out_key: null,
          },
          state: "allowed",
          refusal: null,
        },
      ],
      ["ALPHA-3", null],
      ["ALPHA-4", null],
    ]);
    // The decisions themselves pass through unchanged.
    expect(findings[1]?.["actions"]).toEqual(
      (QUEUE.findings[1] as Record<string, unknown>)["actions"],
    );
  });

  it("attention shows a recommended action that is blocked with its refusal", async () => {
    const blocked = {
      ...QUEUE,
      findings: [
        finding(5, {
          actions: [
            action(
              "retry_run",
              "Retry the run",
              { ticket: 5, run: "WFR-example-5" },
              {
                recommended: "A fresh attempt is the only repair.",
                refusal: {
                  code: "ACTIVE_ATTEMPT_EXISTS",
                  message: "The run already has an active attempt.",
                  instead: "terminate_run",
                },
              },
            ),
          ],
        }),
      ],
    };
    const { ctx } = await setup({ respond: () => ok(blocked, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    const findings = (body.data as { findings: Record<string, unknown>[] }).findings;
    expect(findings[0]?.["recommended_action"]).toMatchObject({
      action: "retry_run",
      reason: "A fresh attempt is the only repair.",
      state: "blocked",
      refusal: {
        code: "ACTIVE_ATTEMPT_EXISTS",
        message: "The run already has an active attempt.",
        instead: "terminate_run",
      },
    });
  });

  it("attention with an empty queue returns no findings and when the sweep last ran", async () => {
    const empty = {
      findings: [],
      open_count: 0,
      ticket_count: 0,
      swept_at: "2026-09-27T08:00:00Z",
    };
    const { ctx } = await setup({ respond: () => ok(empty, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({ ok: true, data: empty, error: null });
  });

  it("attention prints the requests list and request_counts exactly as the server returns them", async () => {
    const requests = [
      { decision_key: "request:conv-example-1", request: intakeRequest() },
      {
        decision_key: "request:conv-example-2",
        request: intakeRequest({
          request_id: "conv-example-2",
          decision_key: "request:conv-example-2",
          addressed_to: [
            { user_id: "usr-example-2", display_name: "Other Person", reason: "asked" },
          ],
        }),
      },
    ];
    const queue = { ...QUEUE, requests, request_counts: { me: 1, all: 2 } };
    const { ctx, calls } = await setup({ respond: () => ok(queue, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toEqual({
      ok: true,
      data: shown(queue),
      error: null,
      meta: { ...META, request_id: "req_fake_attention" },
    });
    const data = body.data as { requests: unknown; request_counts: unknown; findings: unknown[] };
    expect(data.requests).toEqual(requests);
    expect(data.request_counts).toEqual({ me: 1, all: 2 });
    // Requests are not findings: they are neither added to the findings nor given a recommended action.
    expect(data.findings).toHaveLength(QUEUE.findings.length);
    for (const entry of data.requests as Record<string, unknown>[]) {
      expect(entry).not.toHaveProperty("recommended_action");
    }
    expect(calls.map((call) => [call.method, call.url.pathname, call.url.search])).toEqual([
      ["GET", "/api/v1/attention", ""],
    ]);
  });

  it("attention prints an empty requests list and zero request_counts as the server returns them", async () => {
    const queue = { ...QUEUE, requests: [], request_counts: { me: 0, all: 0 } };
    const { ctx } = await setup({ respond: () => ok(queue, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(shown(queue));
    expect(body.data).toMatchObject({ requests: [], request_counts: { me: 0, all: 0 } });
  });

  it("attention is unchanged, with no requests or request_counts added, when the server returns none", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(shown(QUEUE));
    expect(body.data).not.toHaveProperty("requests");
    expect(body.data).not.toHaveProperty("request_counts");
  });

  it("attention passes the requests through with --addressee, which still filters the queue only", async () => {
    const queue = { ...QUEUE, requests: [], request_counts: { me: 0, all: 0 }, addressee: "me" };
    const { ctx, calls } = await setup({ respond: () => ok(queue, "req_fake_attention") });
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "me");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ requests: [], request_counts: { me: 0, all: 0 } });
    expect(calls.map((call) => call.url.search)).toEqual(["?addressee=me"]);
  });

  it("attention refused by the server as forbidden (403) exits 3 with its code", async () => {
    const { ctx } = await setup({
      respond: () => publicError(403, "FORBIDDEN", "You may not read the attention queue."),
    });
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "FORBIDDEN",
        message: "You may not read the attention queue.",
        details: { status: 403, request_id: "req_fake_error" },
      },
    });
  });

  it("attention without a credential exits 3 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    await saveConfig(ctx, { default_profile: "default", profiles: {} } as Config);
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an argument", ["review", "attention", "ALPHA-2"]],
    ["an unknown flag", ["review", "attention", "--type", "clarification_needed"]],
    ["an unknown addressee", ["review", "attention", "--addressee", "someone"]],
    ["an empty addressee", ["review", "attention", "--addressee", ""]],
    ["a missing addressee value", ["review", "attention", "--addressee"]],
  ])("usage: attention with %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await run(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toHaveLength(0);
  });
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: review list at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["review", "list"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Review tickets", "specification"]) expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});

// AC-adf559235e77 / AC-04681e2aa962 / AC-61fe2d8c300e: presentation only.
it.each([40, 80, 120])("resource presentation: review attention at %s columns", async (columns) => {
  const { ctx, calls } = await setup();
  ctx.io.stdoutColumns = columns;
  const argv = ["review", "attention"];
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(ExitCode.Ok);
  const json = envelope(ctx);
  const previousCalls = [...calls];
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of ["Attention queue", "Findings", "Actions", "Recommended action"])
    expect(output).toContain(value);
  expect(calls).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  expect(json.ok).toBe(true);
});
