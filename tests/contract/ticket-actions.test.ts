import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { ApiClient } from "../../src/core/http.js";
import { runPreviewApply, serverPreviewApply } from "../../src/core/preview.js";
import type { components } from "../../src/generated/api.js";
import { envelope, testContext, type TestContext } from "../support/context.js";
import { COMMITTED_DOCUMENT, useMockServer } from "../support/mock-server.js";

// The Ticket actions routes (GET /tickets/{ref}/actions, POST …/actions/preview and
// POST …/actions/execute), as the App Service publishes them, against Prism mocking the committed
// contracts/openapi.json. Prism generates responses from the document's schemas and
// refuses a request body the document does not accept, so these tests check that the bodies the
// CLI sends and the shapes it reads are the ones the contract states.

const server = useMockServer(COMMITTED_DOCUMENT);

type ActionDecision = components["schemas"]["ActionDecision"];
type ActionTarget = components["schemas"]["ActionTarget"];

interface Body {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

async function setup() {
  const sent: Array<{ url: string; method: string }> = [];
  const ctx = await testContext({
    env: {
      PIDGEN_API_URL: server().url,
      PIDGEN_TOKEN: "pidgen_cli_fake_contract_token",
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
    },
    fetch: (input, init) => {
      sent.push({ url: String(input), method: init?.method ?? "GET" });
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

function client(): ApiClient {
  return new ApiClient({
    baseUrl: server().url,
    token: "pidgen_cli_fake_contract_token",
    account: "ACC-EXAMPLE",
    fetch: globalThis.fetch,
    sleep: async () => {},
    timeoutMs: 10_000,
    maxAttempts: 1,
  });
}

const TARGET: ActionTarget = {
  kind: "run",
  ticket_id: "TKT-example",
  run_id: "run-2",
  node_id: null,
  fan_out_key: null,
};

describe("Ticket actions against the Prism mock of the committed document", () => {
  it("pidgen ticket actions lists decisions in the contract's shape, with their state", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "actions",
      "PIDGEN-4",
      "--family",
      "recovery",
      "--run",
      "run-2",
    );
    expect(code).toBe(ExitCode.Ok);
    const data = body.data as { ticket_id: string; actions: Array<Record<string, unknown>> };
    expect(data.ticket_id).toEqual(expect.any(String));
    expect(Array.isArray(data.actions)).toBe(true);
    for (const decision of data.actions) {
      expect(decision).toEqual(
        expect.objectContaining({
          action: expect.any(String),
          label: expect.any(String),
          target: expect.objectContaining({ ticket_id: expect.any(String) }),
          admissible: expect.objectContaining({ allowed: expect.any(Boolean) }),
          authorized: expect.objectContaining({ allowed: expect.any(Boolean) }),
          consequence: expect.objectContaining({ run: expect.any(String) }),
          state: expect.stringMatching(/^(allowed|blocked)$/),
        }),
      );
    }
    expect(sent).toEqual([
      {
        url: `${server().url}/api/v1/tickets/PIDGEN-4/actions?family=recovery&run_id=run-2`,
        method: "GET",
      },
      // The ticket, for its failure projection.
      { url: `${server().url}/api/v1/tickets/PIDGEN-4`, method: "GET" },
    ]);
  });

  it("an unknown --family is refused by the CLI before the server sees it", async () => {
    const { ctx, sent } = await setup();
    const { code } = await run(ctx, "ticket", "actions", "PIDGEN-4", "--family", "other");
    expect(code).toBe(ExitCode.Usage);
    expect(sent).toEqual([]);
  });

  it("drives the actions preview → execute pair through the preview/apply engine", async () => {
    const action = serverPreviewApply(client(), {
      command: "ticket act",
      target: "PIDGEN-4/retry_run/run-2",
      preview: {
        path: "/tickets/PIDGEN-4/actions/preview",
        body: { action: "retry_run", target: TARGET },
      },
      apply: {
        path: "/tickets/PIDGEN-4/actions/execute",
        body: { action: "retry_run", target: TARGET },
      },
    });
    const options = {
      acknowledgements: [] as string[],
      wait: true,
      timeoutMs: 10_000,
      pollIntervalMs: 0,
      sleep: async () => {},
      now: () => 0,
    };

    const previewed = await runPreviewApply(action, { ...options, apply: false });
    if (previewed.mode !== "preview") throw new Error("expected a preview");
    expect(previewed.preview).toEqual(
      expect.objectContaining({
        preview_digest: expect.any(String),
        required_acknowledgements: expect.any(Array),
        action: expect.any(String),
        target: expect.any(Object),
        consequence: expect.objectContaining({ run: expect.any(String) }),
        effects: expect.any(Object),
      }),
    );

    const result = await runPreviewApply(action, {
      ...options,
      apply: true,
      digest: previewed.preview.preview_digest,
      acknowledgements: ["ambiguous_effects"],
      reason: "Worker lost",
    });
    if (result.mode !== "apply") throw new Error("expected an apply");
    expect(result.settled).toBe(true);
    expect(result.result).toEqual(
      expect.objectContaining({
        command_id: expect.any(String),
        ticket_id: expect.any(String),
        status: "applied",
        status_url: expect.any(String),
        action: expect.any(String),
      }),
    );
    expect(result.result).toHaveProperty("disposition_code");
    expect(result.result).toHaveProperty("workflow_run_id");
    expect(result.result).not.toHaveProperty("result");
  });

  it("Prism accepts a remove_dependency execute on a dependency target with a note", async () => {
    const target: ActionTarget = {
      kind: "dependency",
      ticket_id: "TKT-example",
      prerequisite_id: "TKT-prereq-example",
    };
    const response = await client().request({
      method: "POST",
      path: "/tickets/PIDGEN-4/actions/execute",
      body: {
        action: "remove_dependency",
        target,
        preview_digest: "sha256:example",
        idempotency_key: "k".repeat(255),
        acknowledgements: [],
        reason: "r".repeat(10240),
        note: "n".repeat(4000),
      },
      idempotent: true,
    });
    expect(response.status).toBe(200);
  });

  it("pidgen ticket actions passes --family ticket_control and --prerequisite as the published filters", async () => {
    const { ctx, sent } = await setup();
    const { code } = await run(
      ctx,
      "ticket",
      "actions",
      "PIDGEN-4",
      "--family",
      "ticket_control",
      "--prerequisite",
      "TKT-prereq-example",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(sent).toEqual([
      {
        url: `${server().url}/api/v1/tickets/PIDGEN-4/actions?family=ticket_control&prerequisite_id=TKT-prereq-example`,
        method: "GET",
      },
      // The ticket, for its failure projection.
      { url: `${server().url}/api/v1/tickets/PIDGEN-4`, method: "GET" },
    ]);
  });

  it("pidgen api post refuses an execute body the contract does not accept", async () => {
    const response = await client()
      .request({
        method: "POST",
        path: "/tickets/PIDGEN-4/actions/execute",
        body: { action: "retry_run", target: TARGET },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(response).toMatchObject({ exitCode: ExitCode.Usage });
  });

  it("the attention queue's findings carry action decisions and no action field", async () => {
    const { ctx } = await setup();
    const { code, body } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    const findings = (body.data as { findings: Array<Record<string, unknown>> }).findings;
    for (const finding of findings) {
      expect(finding).toHaveProperty("recommended_action");
      expect(finding).not.toHaveProperty("action");
      const actions = finding["actions"] as ActionDecision[] | undefined;
      if (actions !== undefined) expect(Array.isArray(actions)).toBe(true);
    }
  });

  it("pidgen review attention --addressee on_hold uses the documented query and returns the hold view", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "review", "attention", "--addressee", "on_hold");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        findings: expect.any(Array),
        counts: { on_hold: expect.any(Number) },
        review_scope: expect.anything(),
      },
    });
    expect(sent).toEqual([
      { url: `${server().url}/api/v1/attention?addressee=on_hold`, method: "GET" },
    ]);
    const findings = (body.data as { findings: Array<Record<string, unknown>> }).findings;
    for (const finding of findings) {
      expect(finding).toHaveProperty("followup");
      expect(finding).toHaveProperty("hold");
      expect(finding).toHaveProperty("recommended_action");
    }
  });

  it("pidgen review attention without the option sends no addressee", async () => {
    const { ctx, sent } = await setup();
    const { code } = await run(ctx, "review", "attention");
    expect(code).toBe(ExitCode.Ok);
    expect(sent).toEqual([{ url: `${server().url}/api/v1/attention`, method: "GET" }]);
  });

  it("an addressee the contract does not publish is refused by Prism", async () => {
    const response = await client()
      .request({ method: "GET", path: "/attention", query: { addressee: "held" } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(response).toMatchObject({ exitCode: ExitCode.Usage });
  });
});

describe("Decision follow-up actions against the Prism mock of the committed document", () => {
  const DECISION_TARGET: ActionTarget = {
    kind: "decision",
    ticket_id: "TKT-example",
    decision_key: "decision-example-1",
  };
  const options = {
    acknowledgements: [] as string[],
    wait: true,
    timeoutMs: 10_000,
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => 0,
  };

  it.each([
    ["snooze_reminders", { until: "2026-10-12T09:00:00Z", delegate_to: null }],
    ["defer_decision", { until: "2026-10-12T09:00:00+02:00", delegate_to: null }],
    ["keep_holding", { until: "2026-10-12T09:00:00Z", delegate_to: null }],
    ["delegate_decision", { until: null, delegate_to: "user-example-2" }],
    ["hold_decision", undefined],
    ["proceed_on_assumption", undefined],
  ])("%s previews and executes with the same followup choice", async (action, followup) => {
    const subject = {
      action,
      target: DECISION_TARGET,
      ...(followup !== undefined ? { followup } : {}),
    };
    const operation = serverPreviewApply(client(), {
      command: "ticket act",
      target: `PIDGEN-4/${action}/decision-example-1`,
      preview: { path: "/tickets/PIDGEN-4/actions/preview", body: subject },
      apply: { path: "/tickets/PIDGEN-4/actions/execute", body: subject },
    });
    const previewed = await runPreviewApply(operation, { ...options, apply: false });
    if (previewed.mode !== "preview") throw new Error("expected a preview");
    expect(previewed.preview.preview_digest).toEqual(expect.any(String));
    const applied = await runPreviewApply(operation, {
      ...options,
      apply: true,
      digest: previewed.preview.preview_digest,
      reason: "Waiting on the legal review",
    });
    if (applied.mode !== "apply") throw new Error("expected an apply");
    expect(applied.settled).toBe(true);
    expect(applied.result).toEqual(
      expect.objectContaining({ command_id: expect.any(String), status: "applied" }),
    );
  });

  it.each([
    ["until that is not a date-time", { until: "next week" }],
    ["until that is not a string", { until: 5 }],
    ["a delegate that is not a string", { delegate_to: 5 }],
  ])("Prism refuses a followup with %s", async (_, followup) => {
    const error = await client()
      .request({
        method: "POST",
        path: "/tickets/PIDGEN-4/actions/preview",
        body: { action: "defer_decision", target: DECISION_TARGET, followup },
      })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ exitCode: ExitCode.Usage });
  });

  it("Prism refuses an action the contract does not publish", async () => {
    const error = await client()
      .request({
        method: "POST",
        path: "/tickets/PIDGEN-4/actions/preview",
        body: { action: "reboot_everything", target: DECISION_TARGET },
      })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ exitCode: ExitCode.Usage });
  });

  it("pidgen ticket actions lists decision targets in the contract's shape", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "actions",
      "PIDGEN-4",
      "--family",
      "decision_followup",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(sent).toEqual([
      {
        url: `${server().url}/api/v1/tickets/PIDGEN-4/actions?family=decision_followup`,
        method: "GET",
      },
      // The ticket, for its failure projection.
      { url: `${server().url}/api/v1/tickets/PIDGEN-4`, method: "GET" },
    ]);
    expect(Array.isArray((body.data as { actions: unknown[] }).actions)).toBe(true);
  });

  it("the follow-up read is published: decisions and holds for a Ticket", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(ctx, "api", "get", "/tickets/PIDGEN-4/follow-up");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual(
      expect.objectContaining({
        ticket_id: expect.any(String),
        decisions: expect.any(Array),
        holds: expect.any(Array),
      }),
    );
    expect(sent).toEqual([
      { url: `${server().url}/api/v1/tickets/PIDGEN-4/follow-up`, method: "GET" },
    ]);
  });

  it("the clarification result is published with the hold an abandon placed", async () => {
    const { ctx } = await setup();
    const file = join(ctx.cwd, "abandon.json");
    await writeFile(file, JSON.stringify({ outcome: "abandoned", note: "Out of scope." }));
    const { code, body } = await run(
      ctx,
      "api",
      "post",
      "/tickets/PIDGEN-4/clarification",
      "-f",
      file,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toHaveProperty("hold");
    expect(body.data).toHaveProperty("outcome");
  });
});

describe("Plan, start, approve and override actions against the Prism mock of the committed document", () => {
  const TICKET_TARGET: ActionTarget = { kind: "ticket", ticket_id: "TKT-example" };
  const CRITERION_TARGET: ActionTarget = {
    kind: "criterion",
    ticket_id: "TKT-example",
    criterion_index: 2,
  };
  const options = {
    acknowledgements: [] as string[],
    wait: true,
    timeoutMs: 10_000,
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => 0,
  };
  const OVERRIDE = { status: "passing", reason: "Proven by the release smoke test." };
  const ANSWERS = {
    answers: [
      { decision: 0, free_text: "Keep the endpoint." },
      { decision: 1, alternative: "postgres" },
    ],
  };

  async function previewThenExecute(subject: Record<string, unknown>, apply: object = {}) {
    const operation = serverPreviewApply(client(), {
      command: "ticket act",
      target: `PIDGEN-4/${String(subject["action"])}`,
      preview: { path: "/tickets/PIDGEN-4/actions/preview", body: subject },
      apply: { path: "/tickets/PIDGEN-4/actions/execute", body: { ...subject, ...apply } },
    });
    const previewed = await runPreviewApply(operation, { ...options, apply: false });
    if (previewed.mode !== "preview") throw new Error("expected a preview");
    expect(previewed.preview.preview_digest).toEqual(expect.any(String));
    const applied = await runPreviewApply(operation, {
      ...options,
      apply: true,
      digest: previewed.preview.preview_digest,
    });
    if (applied.mode !== "apply") throw new Error("expected an apply");
    expect(applied.settled).toBe(true);
    expect(applied.result).toEqual(
      expect.objectContaining({ command_id: expect.any(String), status: "applied" }),
    );
  }

  it.each([
    ["plan_work", TICKET_TARGET, {}],
    ["start_work", TICKET_TARGET, {}],
    ["ask_before_starting", TICKET_TARGET, {}],
    ["approve_delivery", TICKET_TARGET, {}],
    ["approve_with_exception", TICKET_TARGET, { exception: { reason: "Covered by hand." } }],
    ["correct_plan_decision", TICKET_TARGET, { plan_correction: ANSWERS }],
    ["override_acceptance_criterion", CRITERION_TARGET, { criterion_override: OVERRIDE }],
  ])("%s previews and executes with the same choices", async (action, target, choices) => {
    await previewThenExecute({ action, target, ...choices });
  });

  it("request_delivery_changes executes with the note the execute requires", async () => {
    await previewThenExecute(
      { action: "request_delivery_changes", target: TICKET_TARGET },
      { note: "Cover the empty-input case." },
    );
  });

  it.each([
    ["an exception with an empty reason", { exception: { reason: "" } }],
    [
      "an exception with a reason over 2000 characters",
      { exception: { reason: "r".repeat(2001) } },
    ],
    ["an exception with no reason", { exception: {} }],
    [
      "an override with an unknown status",
      { criterion_override: { status: "maybe", reason: "x" } },
    ],
    ["an override with no status", { criterion_override: { reason: "x" } }],
    ["an override with an empty reason", { criterion_override: { status: "passing", reason: "" } }],
    ["a plan correction with no answers", { plan_correction: { answers: [] } }],
    [
      "a plan correction with more than 50 answers",
      {
        plan_correction: {
          answers: Array.from({ length: 51 }, (_, decision) => ({ decision, free_text: "x" })),
        },
      },
    ],
    [
      "an answer for a negative decision",
      { plan_correction: { answers: [{ decision: -1, free_text: "x" }] } },
    ],
    // An answer with neither or both of alternative and free_text is left to the server; the
    // CLI builds answers from --answer and --alternative, one per decision, and never sends one.
    ["a target with a criterion index that is not an integer", null],
  ])("Prism refuses %s", async (_, choices) => {
    const body =
      choices === null
        ? {
            action: "override_acceptance_criterion",
            target: { ...CRITERION_TARGET, criterion_index: "first" },
            criterion_override: OVERRIDE,
          }
        : { action: "approve_with_exception", target: TICKET_TARGET, ...choices };
    const error = await client()
      .request({ method: "POST", path: "/tickets/PIDGEN-4/actions/preview", body })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ exitCode: ExitCode.Usage });
  });

  it.each([
    ["an answer chosen from the alternatives", { decision: 0, alternative: "a" }],
    ["a free-text answer", { decision: 0, free_text: "text" }],
    ["an alternative with the free text null", { decision: 0, alternative: "a", free_text: null }],
    ["a free text with the alternative null", { decision: 0, alternative: null, free_text: "t" }],
  ])("Prism accepts %s", async (_, answer) => {
    const response = await client().request({
      method: "POST",
      path: "/tickets/PIDGEN-4/actions/preview",
      body: {
        action: "correct_plan_decision",
        target: TICKET_TARGET,
        plan_correction: { answers: [answer] },
      },
    });
    expect(response.status).toBe(200);
  });

  it("pidgen ticket actions accepts --family decision_answers", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "actions",
      "PIDGEN-4",
      "--family",
      "decision_answers",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(sent).toEqual([
      {
        url: `${server().url}/api/v1/tickets/PIDGEN-4/actions?family=decision_answers`,
        method: "GET",
      },
      // The ticket, for its failure projection.
      { url: `${server().url}/api/v1/tickets/PIDGEN-4`, method: "GET" },
    ]);
    expect(Array.isArray((body.data as { actions: unknown[] }).actions)).toBe(true);
  });

  it("pidgen ticket act --criterion sends the published criterion_index filter", async () => {
    const { ctx, sent } = await setup();
    const { body } = await run(
      ctx,
      "ticket",
      "act",
      "PIDGEN-4",
      "override_acceptance_criterion",
      "--criterion",
      "2",
      "--criterion-status",
      "passing",
      "--override-reason",
      "Proven by the release smoke test.",
    );
    // Prism answers the listing with whatever the document's examples hold; the filter is what is
    // under test, and that the server accepted it rather than refusing the query.
    expect(sent[0]).toEqual({
      url: `${server().url}/api/v1/tickets/PIDGEN-4/actions?criterion_index=2`,
      method: "GET",
    });
    expect(body.error?.code).not.toBe("CLI_USAGE");
    expect(body.error?.code).not.toBe("INPUT_INVALID");
  });

  it("a criterion_index the contract does not accept is refused by Prism", async () => {
    const error = await client()
      .request({
        method: "GET",
        path: "/tickets/PIDGEN-4/actions",
        query: { criterion_index: "-1" },
      })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ exitCode: ExitCode.Usage });
  });

  it("pidgen ticket act with a choice the kind does not take never reaches the server", async () => {
    const { ctx, sent } = await setup();
    const { code, body } = await run(
      ctx,
      "ticket",
      "act",
      "PIDGEN-4",
      "approve_delivery",
      "--exception-reason",
      "Because.",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(sent).toEqual([]);
  });

  it("the review decision takes an optional exception_reason string", async () => {
    const decide = (body: Record<string, unknown>) =>
      client().request({ method: "POST", path: "/tickets/PIDGEN-4/review/decisions", body });
    const accepted = await decide({ outcome: "approve", exception_reason: "Covered by hand." });
    expect([200, 202]).toContain(accepted.status);
    const withoutReason = await decide({ outcome: "approve" });
    expect([200, 202]).toContain(withoutReason.status);
    const refused = await decide({ outcome: "approve", exception_reason: 5 }).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(refused).toMatchObject({ exitCode: ExitCode.Usage });
  });
});
