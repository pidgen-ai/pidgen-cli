import { readFileSync } from "node:fs";
import { expectMutationParity, type TestContext } from "../support/context.js";
import { renderDetails } from "../../src/core/resource-human.js";
import { runCli } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import contract from "../../contracts/openapi.json" with { type: "json" };
import {
  ACTION_FAMILIES,
  ACTION_KINDS,
  actionKeyTarget,
  actionKind,
} from "../../src/core/actions.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import {
  ACTIONS_PATH,
  EXECUTE_PATH,
  PREVIEW_PATH,
  REF,
  STATUS_PATH,
  TICKET_ID,
  cli,
  criterionTarget,
  decision,
  decisionTarget,
  dependencyTarget,
  executed,
  listing,
  nodeTarget,
  ok,
  preview,
  refusal,
  routeOf,
  runTarget,
  setup,
  ticketTarget,
} from "../support/actions.js";

const LIST = `GET ${ACTIONS_PATH}`;
const PREVIEW = `POST ${PREVIEW_PATH}`;
const EXECUTE = `POST ${EXECUTE_PATH}`;

/** A mocked actions response: allowed, recommended, blocked (with instead) and unauthorized. */
const ACTIONS = listing(
  decision("retry_run", runTarget("run-2"), {
    recommended: "The run stranded on a lost worker; a fresh attempt is safe.",
  }),
  decision("replay_from_node", nodeTarget("verify"), {
    blocked: {
      code: "REPLAY_REQUIRES_PRODUCER",
      message: "Replay the producer node implement instead.",
      instead: "replay_from_node",
    },
  }),
  decision("restart_refinement", runTarget("run-2"), {
    blocked: {
      code: "NOT_A_REFINERY_RUN",
      message: "Only a Refinery run restarts refinement.",
      instead: "retry_run",
    },
  }),
  decision("cancel_ticket", ticketTarget(), {
    unauthorized: {
      code: "FORBIDDEN",
      message: "Only the ticket's owner may cancel it.",
      instead: null,
    },
  }),
);

const actKey = (target: string, digest = "sha256:preview-1", acks: string[] = []) =>
  deriveIdempotencyKey({ command: "ticket act", target: `${REF}/${target}` }, digest, acks);

describe("pidgen ticket actions", () => {
  it("prints each decision's label, allowed or blocked state with the refusal, and recommended reason", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [SHOW]: [ok(detailWith({ workflow_attention: null }))],
    });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.meta).toMatchObject({ request_id: "req-example", account: "ACC-EXAMPLE" });
    expect(body.data?.["ticket_id"]).toBe(TICKET_ID);
    const actions = body.data?.["actions"] as Record<string, unknown>[];
    expect(
      actions.map((action) => ({
        label: action["label"],
        state: action["state"],
        message: (action["refusal"] as { message: string } | null)?.message ?? null,
        instead: (action["refusal"] as { instead: string | null } | null)?.instead ?? null,
        recommended: action["recommended_reason"],
      })),
    ).toEqual([
      {
        label: "Retry the run",
        state: "allowed",
        message: null,
        instead: null,
        recommended: "The run stranded on a lost worker; a fresh attempt is safe.",
      },
      {
        label: "Replay from this node",
        state: "blocked",
        message: "Replay the producer node implement instead.",
        instead: "replay_from_node",
        recommended: null,
      },
      {
        label: "Restart refinement",
        state: "blocked",
        message: "Only a Refinery run restarts refinement.",
        instead: "retry_run",
        recommended: null,
      },
      {
        label: "Cancel the ticket",
        state: "blocked",
        message: "Only the ticket's owner may cancel it.",
        instead: null,
        recommended: null,
      },
    ]);
    expect(actions.map((action) => action["blocked_by"])).toEqual([
      null,
      "admissible",
      "admissible",
      "authorized",
    ]);
    // The server's decision is kept unchanged beside the added fields, consequence included.
    expect(actions[0]).toMatchObject(ACTIONS.actions[0]!);
    expect(actions[0]?.["consequence"]).toEqual({
      run: "fresh",
      inputs: [
        { class: "configuration", mode: "preserve" },
        { class: "contract", mode: "adopt" },
      ],
    });
    expect(actions[1]?.["refusal"]).toEqual({
      code: "REPLAY_REQUIRES_PRODUCER",
      message: "Replay the producer node implement instead.",
      instead: "replay_from_node",
    });
    // The ticket is read for its failure projection; it carries none, so the actions stand alone.
    expect(calls.map(routeOf)).toEqual([LIST, SHOW]);
    expect(body.data).not.toHaveProperty("failure");
    expect(calls[0]?.query).toEqual({});
    expect(calls[0]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("passes --family, --run and --node to the server as filters", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(listing())] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "actions",
      REF,
      "--family",
      "run_control",
      "--run",
      "run-2",
      "--node",
      "implement",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ ticket_id: TICKET_ID, actions: [] });
    expect(calls[0]?.query).toEqual({
      family: "run_control",
      run_id: "run-2",
      node_id: "implement",
    });
  });

  it("accepts --family ticket_control and passes --prerequisite as the prerequisite_id filter", async () => {
    const dependencies = listing(
      decision("remove_dependency", dependencyTarget("TKT-prereq-1"), {
        recommended: "The prerequisite was abandoned, so this ticket waits on nothing.",
      }),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(dependencies)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "actions",
      REF,
      "--family",
      "ticket_control",
      "--prerequisite",
      "TKT-prereq-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ family: "ticket_control", prerequisite_id: "TKT-prereq-1" });
    const actions = body.data?.["actions"] as Record<string, unknown>[];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: "remove_dependency",
      family: "ticket_control",
      target: { kind: "dependency", prerequisite_id: "TKT-prereq-1" },
      state: "allowed",
    });
    // A dependency target omits run_id, node_id and fan_out_key, which the contract makes optional.
    expect(actions[0]?.["target"]).not.toHaveProperty("run_id");
  });

  it("an unknown ticket exits 4 with the server's code", async () => {
    const { ctx } = await setup({ [LIST]: [refusal(404, "TICKET_NOT_FOUND", "No such ticket.")] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
  });

  it("a caller without ticket.read exits 3 with the server's code", async () => {
    const { ctx } = await setup({ [LIST]: [refusal(403, "FORBIDDEN", "You may not read it.")] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({ code: "FORBIDDEN", message: "You may not read it." });
  });

  it("an answer without a decision list exits 1", async () => {
    const { ctx } = await setup({ [LIST]: [ok({ ticket_id: TICKET_ID })] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });

  it.each([
    ["no ref", ["ticket", "actions"]],
    ["a malformed ref", ["ticket", "actions", "../x"]],
    ["an unknown family", ["ticket", "actions", REF, "--family", "everything"]],
    ["an empty --run", ["ticket", "actions", REF, "--run", ""]],
    ["an overlong --node", ["ticket", "actions", REF, "--node", "n".repeat(257)]],
    ["an overlong --run", ["ticket", "actions", REF, "--run", "r".repeat(129)]],
    ["an empty --prerequisite", ["ticket", "actions", REF, "--prerequisite", ""]],
    ["an overlong --prerequisite", ["ticket", "actions", REF, "--prerequisite", "p".repeat(129)]],
    ["an extra argument", ["ticket", "actions", REF, "PIDGEN-5"]],
  ])("usage: %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toEqual([]);
  });
});

describe("pidgen ticket act", () => {
  it("without --apply previews the action and prints its consequence and acknowledgements", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget(), { acks: ["ambiguous_effects"] }))],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        preview_digest: "sha256:preview-1",
        required_acknowledgements: ["ambiguous_effects"],
        action: "retry_run",
        target: runTarget(),
        consequence: { run: "fresh", inputs: [{ class: "configuration", mode: "preserve" }, {}] },
        effects: { reexecuted_nodes: ["plan", "implement"] },
        decision: { label: "Retry the run", recommended: { reason: expect.any(String) } },
      },
      meta: { request_id: "req-example" },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
    expect(calls[1]?.body).toEqual({ action: "retry_run", target: runTarget() });
  });

  it("--apply --acknowledge sends the preview_digest, acknowledgements, reason and a generated key", async () => {
    const acks = ["ambiguous_effects", "completed_source"];
    const key = actKey("retry_run/run-2", "sha256:preview-7", acks);
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget(), { acks, digest: "sha256:preview-7" }))],
      [EXECUTE]: [ok(executed("retry_run", runTarget()))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "retry_run",
      "--run",
      "run-2",
      "--reason",
      "Worker lost",
      "--apply",
      "--acknowledge",
      "ambiguous-effects",
      "completed_source",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    expect(calls[0]?.query).toEqual({ run_id: "run-2" });
    expect(calls[2]?.body).toEqual({
      action: "retry_run",
      target: runTarget(),
      preview_digest: "sha256:preview-7",
      idempotency_key: key,
      acknowledgements: acks,
      reason: "Worker lost",
    });
    expect(key).toMatch(/^pidgen-[0-9a-f]{32}$/);
    expect(body).toMatchObject({
      ok: true,
      data: { settled: true, idempotency_key: key, result: { status: "applied" } },
    });
  });

  it("--apply with --ack and --acknowledge together sends both", async () => {
    const acks = ["ambiguous_effects", "completed_source"];
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget(), { acks }))],
      [EXECUTE]: [ok(executed("retry_run", runTarget()))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "retry-run",
      "--apply",
      "--ack",
      "completed_source",
      "--acknowledge",
      "ambiguous_effects",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[2]?.body).toMatchObject({ acknowledgements: acks });
  });

  it("--apply without a required acknowledgement exits 6 and executes nothing", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget(), { acks: ["ambiguous_effects"] }))],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run", "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error).toMatchObject({
      code: "ACKNOWLEDGEMENT_REQUIRED",
      details: { missing: ["ambiguous_effects"], preview: { preview_digest: "sha256:preview-1" } },
    });
    expect(body.error?.details["next"]).toContain("--ack ambiguous_effects");
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
  });

  it("--apply --digest executes that digest without previewing again", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [EXECUTE]: [ok(executed("retry_run", runTarget()))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "retry_run",
      "--apply",
      "--digest",
      "sha256:preview-3",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE]);
    expect(calls[1]?.body).toMatchObject({
      preview_digest: "sha256:preview-3",
      idempotency_key: actKey("retry_run/run-2", "sha256:preview-3"),
    });
    expect(body.data).toMatchObject({ settled: true });
  });

  it("a refused execute exits 5 and prints the refusal code and message", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
      [EXECUTE]: [
        refusal(409, "ACTIVE_ATTEMPT_EXISTS", "The run already has an active attempt.", {
          instead: "pause_run",
        }),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run", "--apply");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "ACTIVE_ATTEMPT_EXISTS",
        message: "The run already has an active attempt.",
        details: { status: 409, request_id: "req-example", instead: "pause_run" },
      },
    });
  });

  it("an execute refused for permission exits 3 with its code and message", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
      [EXECUTE]: [refusal(403, "FORBIDDEN", "You may not retry runs.")],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run", "--apply");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({ code: "FORBIDDEN", message: "You may not retry runs." });
  });

  it("an execute refused with PREVIEW_STALE exits 6 and says to preview again", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
      [EXECUTE]: [refusal(409, "PREVIEW_STALE", "The decision changed since the preview.")],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run", "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
    expect(body.error?.details["next"]).toContain("Preview again");
  });

  it("a blocked decision exits 5 with its refusal code, message and instead, previewing nothing", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ACTIONS)] });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "restart_refinement");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "NOT_A_REFINERY_RUN",
        message: "Only a Refinery run restarts refinement.",
        details: { action: "restart_refinement", blocked_by: "admissible", instead: "retry_run" },
      },
    });
    expect(body.error?.details["next"]).toContain(`pidgen ticket act ${REF} retry_run`);
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("a decision the caller may not take exits 3 with its refusal", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ACTIONS)] });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "cancel_ticket", "--apply");
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "Only the ticket's owner may cancel it.",
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("--node picks the decision for that node and is passed as a filter", async () => {
    const twoNodes = listing(
      decision("recover_parked_node", nodeTarget("implement")),
      decision("recover_parked_node", nodeTarget("verify")),
    );
    const { ctx, calls } = await setup({
      [LIST]: [ok(twoNodes)],
      [PREVIEW]: [ok(preview("recover_parked_node", nodeTarget("verify")))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "recover_parked_node",
      "--node",
      "verify",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ node_id: "verify" });
    expect(calls[1]?.body).toEqual({
      action: "recover_parked_node",
      target: nodeTarget("verify"),
    });
  });

  it("--fan-out-key picks one fan-out item", async () => {
    const fanOut = listing(
      decision("replay_from_node", nodeTarget("review", "run-2", "item-1")),
      decision("replay_from_node", nodeTarget("review", "run-2", "item-2")),
    );
    const { ctx, calls } = await setup({
      [LIST]: [ok(fanOut)],
      [PREVIEW]: [ok(preview("replay_from_node", nodeTarget("review", "run-2", "item-2")))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "replay_from_node",
      "--fan-out-key",
      "item-2",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({ target: { fan_out_key: "item-2" } });
  });

  it("an action offered on several targets without a narrowing flag exits 2", async () => {
    const twoRuns = listing(
      decision("retry_run", runTarget("run-2")),
      decision("retry_run", runTarget("run-1")),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(twoRuns)] });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({
      code: "ACTION_TARGET_AMBIGUOUS",
      details: { targets: [runTarget("run-2"), runTarget("run-1")] },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("an action the ticket does not offer exits 5 with ACTION_NOT_OFFERED", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ACTIONS)] });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "pause_run");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "ACTION_NOT_OFFERED",
      details: { action: "pause_run" },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("--wait follows a 202 status_url to the settled result", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
      [EXECUTE]: [ok(executed("retry_run", runTarget(), { status: "applying" }), 202)],
      [`GET ${STATUS_PATH}`]: [
        ok(executed("retry_run", runTarget(), { status: "applying" }), 202),
        ok(executed("retry_run", runTarget())),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry_run", "--apply", "--wait");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([
      LIST,
      PREVIEW,
      EXECUTE,
      `GET ${STATUS_PATH}`,
      `GET ${STATUS_PATH}`,
    ]);
    expect(body.data).toMatchObject({
      settled: true,
      result: { status: "applied", workflow_run_id: "run-3", command_id: expect.any(String) },
    });
    expect((body.data?.["result"] as Record<string, unknown>)["result"]).toBeUndefined();
  });

  it("--no-wait returns the accepted execute and its status route", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
      [EXECUTE]: [ok(executed("retry_run", runTarget(), { status: "applying" }), 202)],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "retry_run",
      "--apply",
      "--no-wait",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ settled: false, handle: STATUS_PATH });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
  });

  it("remove_dependency --prerequisite previews the dependency target it names", async () => {
    const dependencies = listing(
      decision("remove_dependency", dependencyTarget("TKT-prereq-1")),
      decision("remove_dependency", dependencyTarget("TKT-prereq-2")),
    );
    const { ctx, calls } = await setup({
      [LIST]: [ok(dependencies)],
      [PREVIEW]: [ok(preview("remove_dependency", dependencyTarget("TKT-prereq-2")))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "remove-dependency",
      "--prerequisite",
      "TKT-prereq-2",
      "--family",
      "ticket_control",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
    expect(calls[0]?.query).toEqual({ family: "ticket_control", prerequisite_id: "TKT-prereq-2" });
    expect(calls[1]?.body).toEqual({
      action: "remove_dependency",
      target: dependencyTarget("TKT-prereq-2"),
    });
    expect(body.data).toMatchObject({
      action: "remove_dependency",
      decision: { family: "ticket_control", target: { prerequisite_id: "TKT-prereq-2" } },
    });
  });

  it("--apply --note sends the note beside the reason, and the result is the published one", async () => {
    const target = dependencyTarget("TKT-prereq-1");
    const key = actKey("remove_dependency/TKT-prereq-1");
    const { ctx, calls } = await setup({
      [LIST]: [ok(listing(decision("remove_dependency", target)))],
      [PREVIEW]: [ok(preview("remove_dependency", target))],
      [EXECUTE]: [ok(executed("remove_dependency", target, { workflowRunId: null }))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "remove_dependency",
      "--prerequisite",
      "TKT-prereq-1",
      "--reason",
      "Superseded",
      "--note",
      "The prerequisite was abandoned; nothing else depends on it.",
      "--apply",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    expect(calls[2]?.body).toEqual({
      action: "remove_dependency",
      target,
      preview_digest: "sha256:preview-1",
      idempotency_key: key,
      acknowledgements: [],
      reason: "Superseded",
      note: "The prerequisite was abandoned; nothing else depends on it.",
    });
    expect(body.data).toEqual({
      settled: true,
      idempotency_key: key,
      result: {
        command_id: expect.any(String),
        ticket_id: TICKET_ID,
        status: "applied",
        disposition_code: null,
        workflow_run_id: null,
        status_url: expect.stringContaining(`/api/v1/tickets/${REF}/commands/`),
        action: "remove_dependency",
        target,
      },
    });
  });

  it("without --note the execute request sends no note", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
      [EXECUTE]: [ok(executed("retry_run", runTarget()))],
    });
    const { code } = await cli(ctx, "ticket", "act", REF, "retry_run", "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[2]?.body).not.toHaveProperty("note");
  });

  it("accepts the longest reason, note and idempotency key and the most acknowledgements the contract allows", async () => {
    const acks = Array.from({ length: 20 }, (_, n) => `ack_${String(n).padStart(2, "0")}`);
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS)],
      [EXECUTE]: [ok(executed("retry_run", runTarget()))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "retry_run",
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--reason",
      "r".repeat(10240),
      "--note",
      "n".repeat(4000),
      "--idempotency-key",
      "k".repeat(255),
      ...acks.flatMap((ack) => ["--ack", ack]),
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({
      reason: "r".repeat(10240),
      note: "n".repeat(4000),
      idempotency_key: "k".repeat(255),
      acknowledgements: acks,
    });
  });

  it.each([
    ["a reason over 10240 characters", ["--reason", "r".repeat(10241)], "$.reason"],
    ["a note over 4000 characters", ["--note", "n".repeat(4001)], "$.note"],
    [
      "an idempotency key over 255 characters",
      ["--idempotency-key", "k".repeat(256)],
      "$.idempotency_key",
    ],
    [
      "more than 20 acknowledgements",
      Array.from({ length: 21 }, (_, n) => ["--ack", `ack_${n}`]).flat(),
      "$.acknowledgements",
    ],
  ])("--apply with %s exits 2 and executes nothing", async (_, extra, path) => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ACTIONS)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "retry_run",
      "--apply",
      "--digest",
      "sha256:preview-1",
      ...extra,
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null });
    expect(JSON.stringify(body.error)).toContain(path);
    expect(calls.map(routeOf)).not.toContain(EXECUTE);
  });

  it.each([
    ["no action", ["ticket", "act", REF]],
    ["an unknown action", ["ticket", "act", REF, "reboot_everything"]],
    ["--digest without --apply", ["ticket", "act", REF, "retry_run", "--digest", "sha256:x"]],
    ["a malformed --acknowledge code", ["ticket", "act", REF, "retry_run", "--acknowledge", "a b"]],
    ["an empty --node", ["ticket", "act", REF, "retry_run", "--node", ""]],
    ["an empty --prerequisite", ["ticket", "act", REF, "remove_dependency", "--prerequisite", ""]],
    ["an unknown --family", ["ticket", "act", REF, "retry_run", "--family", "everything"]],
    ["a malformed ref", ["ticket", "act", "../x", "retry_run"]],
    ["an extra argument", ["ticket", "act", REF, "retry_run", "extra"]],
  ])("usage: %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toEqual([]);
  });
});

/**
 * The flags a kind that requires a choice is taken with: a missing one is a usage error before the
 * server is asked anything, so a test that wants the server's answer gives them.
 */
const REQUIRED_CHOICES: Record<string, string[]> = {
  approve_with_exception: ["--exception-reason", "Covered by hand."],
  override_acceptance_criterion: [
    "--criterion-status",
    "passing",
    "--override-reason",
    "Proven by the smoke test.",
  ],
  correct_plan_decision: ["--alternative", "0=sqlite"],
  request_delivery_changes: ["--note", "Cover the empty-input case."],
};

describe("action kinds and families come from the contract", () => {
  const schemas = contract.components.schemas;

  it("ACTION_KINDS and ACTION_FAMILIES are the contract's ActionKind and ActionFamily enums", () => {
    expect([...ACTION_KINDS]).toEqual(schemas.ActionKind.enum);
    expect([...ACTION_FAMILIES]).toEqual(schemas.ActionFamily.enum);
  });

  it.each([
    "snooze_reminders",
    "defer_decision",
    "hold_decision",
    "delegate_decision",
    "proceed_on_assumption",
    "keep_holding",
    "retry_admission",
  ])("the contract publishes %s and pidgen ticket act accepts it", (kind) => {
    expect(schemas.ActionKind.enum).toContain(kind);
    expect(actionKind(kind)).toBe(kind);
    expect(actionKind(kind.replaceAll("_", "-"))).toBe(kind);
  });

  it("the contract publishes the decision_followup family and the decision target", () => {
    expect(schemas.ActionFamily.enum).toContain("decision_followup");
    expect(schemas.TargetKind.enum).toContain("decision");
    expect(actionKind("retry_run")).toBe("retry_run");
  });

  it.each(ACTION_KINDS.map((kind) => [kind]))(
    "pidgen ticket act takes %s through to the actions list",
    async (kind) => {
      const { ctx, calls } = await setup({ [LIST]: [ok(listing())] });
      const { code, body } = await cli(
        ctx,
        "ticket",
        "act",
        REF,
        kind,
        ...(REQUIRED_CHOICES[kind] ?? []),
      );
      // The kind is accepted: the CLI asks the server what it offers and finds nothing to preview.
      expect(code).toBe(ExitCode.Refused);
      expect(body.error).toMatchObject({ code: "ACTION_NOT_OFFERED", details: { action: kind } });
      expect(calls.map(routeOf)).toEqual([LIST]);
    },
  );

  it.each([...ACTION_FAMILIES].map((family) => [family]))(
    "--family %s is accepted and passed to the server",
    async (family) => {
      const { ctx, calls } = await setup({ [LIST]: [ok(listing())] });
      const { code } = await cli(ctx, "ticket", "actions", REF, "--family", family);
      expect(code).toBe(ExitCode.Ok);
      expect(calls[0]?.query).toEqual({ family });
    },
  );

  it("a retry_admission decision is previewed like any other", async () => {
    const admission = decision("retry_admission", ticketTarget(), {
      recommended: "The workspace could not be prepared; trying again is safe.",
    });
    const { ctx, calls } = await setup({
      [LIST]: [ok(listing(admission))],
      [PREVIEW]: [ok(preview("retry_admission", ticketTarget()))],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "retry-admission");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
    expect(calls[1]?.body).toEqual({ action: "retry_admission", target: ticketTarget() });
    expect(body.data).toMatchObject({ action: "retry_admission" });
  });

  it("an unknown action lists every published kind", async () => {
    const { ctx } = await setup();
    const { code, body } = await cli(ctx, "ticket", "act", REF, "reboot_everything");
    expect(code).toBe(ExitCode.Usage);
    for (const kind of schemas.ActionKind.enum) expect(body.error?.message).toContain(kind);
  });
});

const DECISION = "decision-example-1";
const UNTIL = "2026-10-12T09:00:00Z";

/** A ticket with one decision waiting on a person and every follow-up action decided for it. */
const FOLLOW_UP = listing(
  decision("snooze_reminders", decisionTarget(DECISION)),
  decision("defer_decision", decisionTarget(DECISION)),
  decision("hold_decision", decisionTarget(DECISION)),
  decision("delegate_decision", decisionTarget(DECISION)),
  decision("proceed_on_assumption", decisionTarget(DECISION)),
  decision("keep_holding", decisionTarget(DECISION)),
  decision("retry_run", runTarget("run-2")),
);

describe("--decision names the decision an action acts on", () => {
  it("pidgen ticket actions keeps only the decisions whose target names the decision", async () => {
    const two = listing(
      decision("hold_decision", decisionTarget(DECISION)),
      decision("hold_decision", decisionTarget("decision-example-2")),
      decision("retry_run", runTarget("run-2")),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(two)] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF, "--decision", DECISION);
    expect(code).toBe(ExitCode.Ok);
    const actions = body.data?.["actions"] as Record<string, unknown>[];
    expect(actions.map((action) => action["target"])).toEqual([decisionTarget(DECISION)]);
    expect(actions[0]).toMatchObject({
      action: "hold_decision",
      family: "decision_followup",
      state: "allowed",
    });
    // The actions route publishes no decision filter, so none is sent.
    expect(calls[0]?.query).toEqual({});
  });

  it("pidgen ticket actions combines --decision with --family", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(FOLLOW_UP)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "actions",
      REF,
      "--family",
      "decision_followup",
      "--decision",
      DECISION,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ family: "decision_followup" });
    expect((body.data?.["actions"] as unknown[]).length).toBe(6);
  });

  it("pidgen ticket act picks the decision it names among several offering the action", async () => {
    const two = listing(
      decision("hold_decision", decisionTarget(DECISION)),
      decision("hold_decision", decisionTarget("decision-example-2")),
    );
    const { ctx, calls } = await setup({
      [LIST]: [ok(two)],
      [PREVIEW]: [ok(preview("hold_decision", decisionTarget("decision-example-2")))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "hold_decision",
      "--decision",
      "decision-example-2",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({});
    expect(calls[1]?.body).toEqual({
      action: "hold_decision",
      target: decisionTarget("decision-example-2"),
    });
  });

  it("an action offered for several decisions without --decision exits 2 and names the flag", async () => {
    const two = listing(
      decision("hold_decision", decisionTarget(DECISION)),
      decision("hold_decision", decisionTarget("decision-example-2")),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(two)] });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "hold_decision");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({
      code: "ACTION_TARGET_AMBIGUOUS",
      details: { targets: [decisionTarget(DECISION), decisionTarget("decision-example-2")] },
    });
    expect(body.error?.message).toContain("--decision");
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("a decision the ticket does not offer the action for exits 5 with ACTION_NOT_OFFERED", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(FOLLOW_UP)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "hold_decision",
      "--decision",
      "decision-unknown",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "ACTION_NOT_OFFERED",
      details: { action: "hold_decision", decision_key: "decision-unknown" },
    });
    expect(body.error?.message).toContain("decision-unknown");
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("the idempotency key's target includes the decision", async () => {
    const target = decisionTarget(DECISION);
    expect(actionKeyTarget(REF, "hold_decision", target)).toBe(`${REF}/hold_decision/${DECISION}`);
    const key = actKey(`hold_decision/${DECISION}`, "sha256:preview-1");
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [PREVIEW]: [ok(preview("hold_decision", target))],
      [EXECUTE]: [ok(executed("hold_decision", target, { workflowRunId: null }))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "hold_decision",
      "--decision",
      DECISION,
      "--reason",
      "Waiting on the legal review",
      "--apply",
    );
    expect(code).toBe(ExitCode.Ok);
    // hold_decision records the execute's existing reason.
    expect(calls[2]?.body).toEqual({
      action: "hold_decision",
      target,
      preview_digest: "sha256:preview-1",
      idempotency_key: key,
      acknowledgements: [],
      reason: "Waiting on the legal review",
    });
    expect(calls[1]?.body).toEqual({ action: "hold_decision", target });
    expect(body.data).toMatchObject({ settled: true, idempotency_key: key });
  });

  it.each([
    ["an empty --decision", ["ticket", "actions", REF, "--decision", ""]],
    ["an overlong --decision", ["ticket", "actions", REF, "--decision", "d".repeat(257)]],
    ["an empty --decision on act", ["ticket", "act", REF, "hold_decision", "--decision", ""]],
    [
      "an overlong --decision on act",
      ["ticket", "act", REF, "hold_decision", "--decision", "d".repeat(257)],
    ],
  ])("usage: %s exits 2 and sends nothing", async (_, argv) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, ...argv);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toEqual([]);
  });
});

describe("pidgen ticket act --until and --delegate-to", () => {
  const followUpKey = (action: string, digest = "sha256:preview-1") =>
    actKey(`${action}/${DECISION}`, digest);

  it.each(["snooze_reminders", "defer_decision", "keep_holding"])(
    "%s --until previews and executes with the same followup choice",
    async (action) => {
      const target = decisionTarget(DECISION);
      const { ctx, calls } = await setup({
        [LIST]: [ok(FOLLOW_UP), ok(FOLLOW_UP)],
        [PREVIEW]: [ok(preview(action, target)), ok(preview(action, target))],
        [EXECUTE]: [ok(executed(action, target, { workflowRunId: null }))],
      });
      const preview1 = await cli(
        ctx,
        "ticket",
        "act",
        REF,
        action,
        "--decision",
        DECISION,
        "--until",
        UNTIL,
      );
      expect(preview1.code).toBe(ExitCode.Ok);
      expect(preview1.body.data).toMatchObject({
        preview_digest: "sha256:preview-1",
        action,
        decision: { action, target },
      });
      expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
      expect(calls[1]?.body).toEqual({
        action,
        target,
        followup: { until: UNTIL, delegate_to: null },
      });

      calls.length = 0;
      const applied = await cli(
        ctx,
        "ticket",
        "act",
        REF,
        action,
        "--decision",
        DECISION,
        "--until",
        UNTIL,
        "--apply",
      );
      expect(applied.code).toBe(ExitCode.Ok);
      expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
      expect(calls[1]?.body).toEqual({
        action,
        target,
        followup: { until: UNTIL, delegate_to: null },
      });
      expect(calls[2]?.body).toEqual({
        action,
        target,
        followup: { until: UNTIL, delegate_to: null },
        preview_digest: "sha256:preview-1",
        idempotency_key: followUpKey(action),
        acknowledgements: [],
      });
      expect(applied.body.data).toMatchObject({
        settled: true,
        result: { status: "applied", action },
      });
    },
  );

  it("delegate_decision --delegate-to sends the user on both requests", async () => {
    const target = decisionTarget(DECISION);
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [PREVIEW]: [ok(preview("delegate_decision", target))],
      [EXECUTE]: [ok(executed("delegate_decision", target, { workflowRunId: null }))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "delegate-decision",
      "--decision",
      DECISION,
      "--delegate-to",
      "user-example-2",
      "--reason",
      "Out next week",
      "--apply",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    const followup = { until: null, delegate_to: "user-example-2" };
    expect(calls[1]?.body).toEqual({ action: "delegate_decision", target, followup });
    expect(calls[2]?.body).toMatchObject({
      action: "delegate_decision",
      target,
      followup,
      reason: "Out next week",
    });
    expect(body.data).toMatchObject({ settled: true });
  });

  it("--apply --digest sends the followup with that digest and does not preview", async () => {
    const target = decisionTarget(DECISION);
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [EXECUTE]: [ok(executed("defer_decision", target, { workflowRunId: null }))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "defer_decision",
      "--decision",
      DECISION,
      "--until",
      "2026-10-12T09:00:00+02:00",
      "--apply",
      "--digest",
      "sha256:preview-5",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE]);
    expect(calls[1]?.body).toMatchObject({
      followup: { until: "2026-10-12T09:00:00+02:00", delegate_to: null },
      preview_digest: "sha256:preview-5",
      idempotency_key: followUpKey("defer_decision", "sha256:preview-5"),
    });
  });

  it("an actions without a followup choice sends no followup at all", async () => {
    const target = decisionTarget(DECISION);
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [PREVIEW]: [ok(preview("proceed_on_assumption", target))],
      [EXECUTE]: [ok(executed("proceed_on_assumption", target, { workflowRunId: null }))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "proceed_on_assumption",
      "--decision",
      DECISION,
      "--apply",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).not.toHaveProperty("followup");
    expect(calls[2]?.body).not.toHaveProperty("followup");
  });

  it("a follow-up refused at the preview exits 5 with the server's code and sentence", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [PREVIEW]: [
        refusal(409, "FOLLOW_UP_TIME_PAST", "That time has already passed. Choose a later one."),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "snooze_reminders",
      "--decision",
      DECISION,
      "--until",
      "2020-01-01T00:00:00Z",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "FOLLOW_UP_TIME_PAST",
        message: "That time has already passed. Choose a later one.",
      },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
  });

  it("a deferral that is too long exits 5 with DEFER_TOO_LONG and the latest time", async () => {
    const latest = "2026-11-01T09:00:00Z";
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [PREVIEW]: [ok(preview("defer_decision", decisionTarget(DECISION)))],
      [EXECUTE]: [
        refusal(409, "DEFER_TOO_LONG", "That is later than this decision may be deferred.", {
          latest,
        }),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "defer_decision",
      "--decision",
      DECISION,
      "--until",
      "2027-01-01T00:00:00Z",
      "--apply",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "DEFER_TOO_LONG",
      message: "That is later than this decision may be deferred.",
      details: { latest },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
  });

  it("a different choice at the execute exits 6 with PREVIEW_STALE", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [EXECUTE]: [refusal(409, "PREVIEW_STALE", "The choices changed since the preview.")],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "snooze_reminders",
      "--decision",
      DECISION,
      "--until",
      UNTIL,
      "--apply",
      "--digest",
      "sha256:preview-for-another-time",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
  });

  it.each([
    [
      "DECISION_HELD",
      "This decision is held, so this follow-up does not apply.",
      "snooze_reminders",
    ],
    ["HOLD_NOT_APPLICABLE", "This decision cannot be held.", "hold_decision"],
    [
      "NO_RECOMMENDED_ANSWER",
      "This decision has no recommended answer to proceed on.",
      "proceed_on_assumption",
    ],
    ["HOLD_REVIEW_NOT_DUE", "The hold is not due for review yet.", "keep_holding"],
    ["HOLD_REVIEWER_REQUIRED", "Only a reviewer of the hold may decide it.", "keep_holding"],
    ["DELEGATE_NOT_ELIGIBLE", "That person cannot take this decision.", "delegate_decision"],
    ["DELEGATE_NOBODY", "Name the person to delegate this decision to.", "delegate_decision"],
    [
      "HOLD_ALREADY_REQUESTED",
      "A hold has already been requested for this decision.",
      "hold_decision",
    ],
    ["FOLLOW_UP_NOT_FOUND", "This decision has no follow-up to change.", "snooze_reminders"],
  ])(
    "a decision blocked with %s exits 5 with its code and sentence, previewing nothing",
    async (code, message, action) => {
      const blocked = listing(
        decision(action, decisionTarget(DECISION), { blocked: { code, message, instead: null } }),
      );
      const { ctx, calls } = await setup({ [LIST]: [ok(blocked)] });
      const result = await cli(ctx, "ticket", "act", REF, action, "--apply");
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body.error).toMatchObject({
        code,
        message,
        details: { action, blocked_by: "admissible", target: decisionTarget(DECISION) },
      });
      expect(calls.map(routeOf)).toEqual([LIST]);
    },
  );

  it("pidgen ticket actions shows a blocked follow-up with its refusal", async () => {
    const blocked = listing(
      decision("hold_decision", decisionTarget(DECISION), {
        blocked: {
          code: "HOLD_ALREADY_REQUESTED",
          message: "A hold has already been requested for this decision.",
          instead: "keep_holding",
        },
      }),
    );
    const { ctx } = await setup({ [LIST]: [ok(blocked)] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.Ok);
    expect((body.data?.["actions"] as Record<string, unknown>[])[0]).toMatchObject({
      state: "blocked",
      blocked_by: "admissible",
      refusal: { code: "HOLD_ALREADY_REQUESTED", instead: "keep_holding" },
    });
  });

  it.each([
    ["--until with hold_decision", ["hold_decision", "--until", UNTIL]],
    ["--until with delegate_decision", ["delegate_decision", "--until", UNTIL]],
    ["--until with proceed_on_assumption", ["proceed_on_assumption", "--until", UNTIL]],
    ["--until with retry_run", ["retry_run", "--until", UNTIL]],
    ["--delegate-to with snooze_reminders", ["snooze_reminders", "--delegate-to", "user-2"]],
    ["--delegate-to with defer_decision", ["defer_decision", "--delegate-to", "user-2"]],
    ["--delegate-to with keep_holding", ["keep_holding", "--delegate-to", "user-2"]],
    ["--delegate-to with hold_decision", ["hold_decision", "--delegate-to", "user-2"]],
    ["--delegate-to with retry_run", ["retry_run", "--delegate-to", "user-2"]],
    [
      "--until and --delegate-to together on snooze_reminders",
      ["snooze_reminders", "--until", UNTIL, "--delegate-to", "user-2"],
    ],
    [
      "--until and --delegate-to together on delegate_decision",
      ["delegate_decision", "--until", UNTIL, "--delegate-to", "user-2"],
    ],
    ["an empty --until", ["snooze_reminders", "--until", ""]],
    ["an empty --delegate-to", ["delegate_decision", "--delegate-to", ""]],
    ["an overlong --delegate-to", ["delegate_decision", "--delegate-to", "u".repeat(129)]],
    ["--until without a value", ["snooze_reminders", "--until"]],
    ["--delegate-to without a value", ["delegate_decision", "--delegate-to"]],
    ["--until that is only a date", ["defer_decision", "--until", "2026-10-12"]],
    ["--until with no offset", ["defer_decision", "--until", "2026-10-12T09:00:00"]],
    ["--until with no time", ["defer_decision", "--until", "2026-10-12Z"]],
    ["--until that is not a time", ["defer_decision", "--until", "tomorrow"]],
    ["--until with an impossible month", ["defer_decision", "--until", "2026-13-12T09:00:00Z"]],
    ["--until with an impossible day", ["defer_decision", "--until", "2026-02-30T09:00:00Z"]],
    ["--until with an impossible hour", ["defer_decision", "--until", "2026-10-12T25:00:00Z"]],
    [
      "--until with an impossible offset",
      ["defer_decision", "--until", "2026-10-12T09:00:00+25:00"],
    ],
    ["--until with trailing text", ["defer_decision", "--until", "2026-10-12T09:00:00Z now"]],
  ])("usage: %s exits 2 and sends nothing", async (_, args) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "act", REF, ...args);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(calls).toEqual([]);
  });

  it("a choice the action does not take names the option and the actions that take it", async () => {
    const { ctx } = await setup();
    const until = await cli(ctx, "ticket", "act", REF, "hold_decision", "--until", UNTIL);
    expect(until.body.error?.message).toContain("--until");
    for (const kind of ["snooze_reminders", "defer_decision", "keep_holding"]) {
      expect(until.body.error?.message).toContain(kind);
    }
    const delegate = await cli(ctx, "ticket", "act", REF, "hold_decision", "--delegate-to", "u-2");
    expect(delegate.body.error?.message).toContain("--delegate-to");
    expect(delegate.body.error?.message).toContain("delegate_decision");
  });

  it.each([
    "2026-10-12T09:00:00Z",
    "2026-10-12T09:00:00.250Z",
    "2026-10-12T09:00:00+02:00",
    "2026-10-12T09:00:00-07:30",
    "2026-10-12t09:00:00z",
    "2026-10-12T09:00Z",
    "2028-02-29T23:59:59Z",
  ])("--until %s is a date-time with an offset", async (until) => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(FOLLOW_UP)],
      [PREVIEW]: [ok(preview("snooze_reminders", decisionTarget(DECISION)))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "snooze_reminders",
      "--decision",
      DECISION,
      "--until",
      until,
    );
    expect(code).toBe(ExitCode.Ok);
    const sent = (calls[1]?.body as { followup: { until: string } }).followup.until;
    expect(new Date(sent).getTime()).toBe(new Date(until.toUpperCase()).getTime());
  });
});

/** The eight kinds of the plan, start, approve and override contract, and the family they share. */
const DECISION_ANSWER_KINDS = [
  "plan_work",
  "start_work",
  "ask_before_starting",
  "correct_plan_decision",
  "approve_delivery",
  "approve_with_exception",
  "request_delivery_changes",
  "override_acceptance_criterion",
] as const;

/** A ticket for which the server decides every one of them, the criterion one for two criteria. */
const ANSWERS = listing(
  decision("plan_work", ticketTarget()),
  decision("start_work", ticketTarget()),
  decision("ask_before_starting", ticketTarget()),
  decision("correct_plan_decision", ticketTarget()),
  decision("approve_delivery", ticketTarget()),
  decision("approve_with_exception", ticketTarget()),
  decision("request_delivery_changes", ticketTarget()),
  decision("override_acceptance_criterion", criterionTarget(0)),
  decision("override_acceptance_criterion", criterionTarget(2)),
  decision("retry_run", runTarget("run-2")),
);

describe("the plan, start, approve and override kinds", () => {
  const schemas = contract.components.schemas;

  it.each(DECISION_ANSWER_KINDS.map((kind) => [kind]))(
    "the contract publishes %s and pidgen ticket act accepts it",
    (kind) => {
      expect(schemas.ActionKind.enum).toContain(kind);
      expect(ACTION_KINDS).toContain(kind);
      expect(actionKind(kind)).toBe(kind);
      expect(actionKind(kind.replaceAll("_", "-"))).toBe(kind);
    },
  );

  it("the contract publishes the decision_answers family and the criterion target", () => {
    expect(schemas.ActionFamily.enum).toContain("decision_answers");
    expect(ACTION_FAMILIES).toContain("decision_answers");
    expect(schemas.TargetKind.enum).toContain("criterion");
  });

  it("pidgen ticket actions --family decision_answers passes the family and prints each decision", async () => {
    const listed = listing(
      decision("approve_delivery", ticketTarget()),
      decision("override_acceptance_criterion", criterionTarget(1), {
        blocked: {
          code: "REVIEW_NOT_OPEN",
          message: "This Ticket has no delivery review open.",
          instead: null,
        },
      }),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(listed)] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF, "--family", "decision_answers");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ family: "decision_answers" });
    const actions = (body.data as { actions: Array<Record<string, unknown>> }).actions;
    expect(actions.map((a) => [a["action"], a["family"], a["state"]])).toEqual([
      ["approve_delivery", "decision_answers", "allowed"],
      ["override_acceptance_criterion", "decision_answers", "blocked"],
    ]);
    expect(actions[1]).toMatchObject({
      target: { kind: "criterion", criterion_index: 1 },
      refusal: { code: "REVIEW_NOT_OPEN", message: "This Ticket has no delivery review open." },
    });
  });

  it.each(["plan_work", "start_work", "ask_before_starting", "approve_delivery"] as const)(
    "%s previews with its action and target only, and executes the same",
    async (action) => {
      const target = ticketTarget();
      const { ctx, calls } = await setup({
        [LIST]: [ok(ANSWERS), ok(ANSWERS)],
        [PREVIEW]: [ok(preview(action, target)), ok(preview(action, target))],
        [EXECUTE]: [ok(executed(action, target))],
      });
      const previewed = await cli(ctx, "ticket", "act", REF, action);
      expect(previewed.code).toBe(ExitCode.Ok);
      expect(previewed.body.data).toMatchObject({
        preview_digest: "sha256:preview-1",
        action,
        decision: { action, family: "decision_answers" },
      });
      expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
      expect(calls[1]?.body).toEqual({ action, target });

      calls.length = 0;
      const applied = await cli(ctx, "ticket", "act", REF, action, "--apply");
      expect(applied.code).toBe(ExitCode.Ok);
      expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
      expect(calls[2]?.body).toEqual({
        action,
        target,
        preview_digest: "sha256:preview-1",
        idempotency_key: actKey(action),
        acknowledgements: [],
      });
      expect(applied.body.data).toMatchObject({ settled: true, result: { status: "applied" } });
    },
  );

  it("start_work's preview prints its four checks", async () => {
    const checks = [
      { name: "plan_ready", passed: true, detail: null },
      { name: "dependencies_met", passed: true, detail: null },
      { name: "workspace_ready", passed: false, detail: "No workspace is prepared." },
      { name: "capacity_available", passed: true, detail: null },
    ];
    const { ctx } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("start_work", ticketTarget(), { effects: { checks } }))],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "start_work");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ action: "start_work", effects: { checks } });
    expect((body.data as { effects: { checks: unknown[] } }).effects.checks).toHaveLength(4);
  });

  it.each(["ask_before_starting", "correct_plan_decision"] as const)(
    "%s's preview prints the plan's decisions",
    async (action) => {
      const decisions = [
        { decision: 0, question: "Which database?", alternatives: ["sqlite", "postgres"] },
        { decision: 1, question: "Keep the old endpoint?", alternatives: ["keep", "remove"] },
      ];
      const { ctx } = await setup({
        [LIST]: [ok(ANSWERS)],
        [PREVIEW]: [ok(preview(action, ticketTarget(), { effects: { decisions } }))],
      });
      const args =
        action === "correct_plan_decision" ? ["--alternative", "0=sqlite"] : ([] as string[]);
      const { code, body } = await cli(ctx, "ticket", "act", REF, action, ...args);
      expect(code).toBe(ExitCode.Ok);
      expect(body.data).toMatchObject({ action, effects: { decisions } });
    },
  );

  it("start_work blocked with START_CHECKS_FAILED exits 5 with its code and message, previewing nothing", async () => {
    const blocked = listing(
      decision("start_work", ticketTarget(), {
        blocked: {
          code: "START_CHECKS_FAILED",
          message: "A check before starting did not pass.",
          instead: "ask_before_starting",
        },
      }),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(blocked)] });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "start_work");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "START_CHECKS_FAILED",
      message: "A check before starting did not pass.",
      details: { action: "start_work", instead: "ask_before_starting" },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });
});

describe("pidgen ticket act --exception-reason", () => {
  const REASON = "The remaining criterion is covered by the manual check in the review.";

  it("approve_with_exception previews with the exception", async () => {
    const target = ticketTarget();
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("approve_with_exception", target))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_with_exception",
      "--exception-reason",
      REASON,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      action: "approve_with_exception",
      preview_digest: "sha256:preview-1",
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
    expect(calls[1]?.body).toEqual({
      action: "approve_with_exception",
      target,
      exception: { reason: REASON },
    });
  });

  it("--apply sends the same exception on the preview and the execute", async () => {
    const target = ticketTarget();
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("approve_with_exception", target))],
      [EXECUTE]: [ok(executed("approve_with_exception", target))],
    });
    const applied = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve-with-exception",
      "--exception-reason",
      REASON,
      "--reason",
      "Reviewed by hand",
      "--apply",
    );
    expect(applied.code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    expect(calls[1]?.body).toEqual({
      action: "approve_with_exception",
      target,
      exception: { reason: REASON },
    });
    expect(calls[2]?.body).toEqual({
      action: "approve_with_exception",
      target,
      exception: { reason: REASON },
      preview_digest: "sha256:preview-1",
      idempotency_key: actKey("approve_with_exception"),
      acknowledgements: [],
      reason: "Reviewed by hand",
    });
    expect(applied.body.data).toMatchObject({ settled: true, result: { status: "applied" } });
  });

  it("--apply --digest sends the exception with that digest and does not preview", async () => {
    const target = ticketTarget();
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [EXECUTE]: [ok(executed("approve_with_exception", target))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_with_exception",
      "--exception-reason",
      REASON,
      "--apply",
      "--digest",
      "sha256:earlier",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE]);
    expect(calls[1]?.body).toMatchObject({
      exception: { reason: REASON },
      preview_digest: "sha256:earlier",
    });
  });

  it("accepts a reason of the longest length the contract allows", async () => {
    const longest = "r".repeat(2000);
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("approve_with_exception", ticketTarget()))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_with_exception",
      "--exception-reason",
      longest,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({ exception: { reason: longest } });
  });

  it("a refusal for lack of an independent approver exits 5 with its code and message", async () => {
    const message = "This delivery must be approved by someone independent of its author.";
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("approve_with_exception", ticketTarget()))],
      [EXECUTE]: [refusal(409, "INDEPENDENT_APPROVAL_REQUIRED", message)],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_with_exception",
      "--exception-reason",
      REASON,
      "--apply",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "INDEPENDENT_APPROVAL_REQUIRED", message },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
  });

  it.each([
    ["INDEPENDENT_APPROVAL_REQUIRED", "approve_delivery", "approve_with_exception"],
    ["MUST_CRITERIA_NOT_PASSING", "approve_delivery", "approve_with_exception"],
    ["REVIEW_NOT_OPEN", "approve_delivery", null],
    ["BACKLOG_STAGE_REQUIRED", "plan_work", null],
    ["PLANNING_NOT_AVAILABLE", "plan_work", null],
    ["WORK_ALREADY_STARTED", "start_work", null],
  ] as const)(
    "a decision blocked with %s exits 5 with its code and message, naming the action to take instead",
    async (code, action, instead) => {
      const message = `The server's sentence for ${code}.`;
      const blocked = listing(
        decision(action, ticketTarget(), { blocked: { code, message, instead } }),
      );
      const { ctx, calls } = await setup({ [LIST]: [ok(blocked)] });
      const result = await cli(ctx, "ticket", "act", REF, action, "--apply");
      expect(result.code).toBe(ExitCode.Refused);
      expect(result.body.error).toMatchObject({
        code,
        message,
        details: { action, blocked_by: "admissible", instead },
      });
      if (instead !== null) {
        expect(result.body.error?.details["next"]).toContain(`pidgen ticket act ${REF} ${instead}`);
      }
      expect(calls.map(routeOf)).toEqual([LIST]);
    },
  );

  it("approve_delivery refused at the execute for unproven MUST criteria exits 5 with the server's message", async () => {
    const message =
      "Not every MUST criterion is passing. Approve with an exception, or ask for changes.";
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("approve_delivery", ticketTarget()))],
      [EXECUTE]: [
        refusal(409, "MUST_CRITERIA_NOT_PASSING", message, { unproven_criteria: [1, 2] }),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "act", REF, "approve_delivery", "--apply");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "MUST_CRITERIA_NOT_PASSING",
      message,
      details: { unproven_criteria: [1, 2] },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
  });

  it("an exception the server refuses for lack of a reason exits 5 with EXCEPTION_REASON_REQUIRED", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [
        refusal(409, "EXCEPTION_REASON_REQUIRED", "Say why you approve with criteria unproven."),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_with_exception",
      "--exception-reason",
      "Because.",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "EXCEPTION_REASON_REQUIRED",
      message: "Say why you approve with criteria unproven.",
    });
  });
});

describe("pidgen ticket act --criterion, --criterion-status and --override-reason", () => {
  const target = criterionTarget(2);

  it("override_acceptance_criterion --criterion picks the criterion and sends its override on both requests", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("override_acceptance_criterion", target))],
      [EXECUTE]: [ok(executed("override_acceptance_criterion", target))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      "2",
      "--criterion-status",
      "passing",
      "--override-reason",
      "Proven by the release smoke test.",
      "--apply",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    expect(calls[0]?.query).toEqual({ criterion_index: "2" });
    const override = { status: "passing", reason: "Proven by the release smoke test." };
    expect(calls[1]?.body).toEqual({
      action: "override_acceptance_criterion",
      target,
      criterion_override: override,
    });
    expect(calls[2]?.body).toEqual({
      action: "override_acceptance_criterion",
      target,
      criterion_override: override,
      preview_digest: "sha256:preview-1",
      idempotency_key: actKey("override_acceptance_criterion/2"),
      acknowledgements: [],
    });
    expect(body.data).toMatchObject({ settled: true });
  });

  it.each(["passing", "failing", "pending"])("--criterion-status %s is sent", async (status) => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("override_acceptance_criterion", target))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      "2",
      "--criterion-status",
      status,
      "--override-reason",
      "Because.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({ criterion_override: { status, reason: "Because." } });
  });

  it("--criterion 0 names the first criterion and is passed as the criterion_index filter", async () => {
    const first = criterionTarget(0);
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("override_acceptance_criterion", first))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      "0",
      "--criterion-status",
      "failing",
      "--override-reason",
      "It regressed.",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ criterion_index: "0" });
    expect(calls[1]?.body).toMatchObject({ target: first });
  });

  it("the idempotency key's target includes the criterion, also the first one", () => {
    expect(actionKeyTarget(REF, "override_acceptance_criterion", criterionTarget(2))).toBe(
      `${REF}/override_acceptance_criterion/2`,
    );
    expect(actionKeyTarget(REF, "override_acceptance_criterion", criterionTarget(0))).toBe(
      `${REF}/override_acceptance_criterion/0`,
    );
  });

  it("an override offered for several criteria without --criterion exits 2 and names the flag", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ANSWERS)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion-status",
      "passing",
      "--override-reason",
      "Because.",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "ACTION_TARGET_AMBIGUOUS" });
    expect(body.error?.message).toContain("--criterion");
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("a criterion the ticket does not offer exits 5 with ACTION_NOT_OFFERED naming it", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ANSWERS)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      "7",
      "--criterion-status",
      "passing",
      "--override-reason",
      "Because.",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "ACTION_NOT_OFFERED",
      details: { action: "override_acceptance_criterion", criterion_index: 7 },
    });
    expect(body.error?.message).toContain("criterion 7");
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("--criterion narrows any action's target like --prerequisite does", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(ANSWERS)] });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_delivery",
      "--criterion",
      "1",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error?.code).toBe("ACTION_NOT_OFFERED");
    expect(calls[0]?.query).toEqual({ criterion_index: "1" });
  });

  it("a criterion the server refuses exits 5 with CRITERION_NOT_FOUND", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [
        refusal(409, "CRITERION_NOT_FOUND", "This Ticket has no criterion at that position."),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      "2",
      "--criterion-status",
      "passing",
      "--override-reason",
      "Because.",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "CRITERION_NOT_FOUND",
      message: "This Ticket has no criterion at that position.",
    });
  });

  it("an override the server refuses at the execute exits 5 with OVERRIDE_REASON_REQUIRED", async () => {
    const message = "Say why you are overriding this criterion.";
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("override_acceptance_criterion", target))],
      [EXECUTE]: [refusal(409, "OVERRIDE_REASON_REQUIRED", message)],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      "2",
      "--criterion-status",
      "passing",
      "--override-reason",
      "Because.",
      "--apply",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "OVERRIDE_REASON_REQUIRED", message },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
  });
});

describe("pidgen ticket act --answer and --alternative", () => {
  const target = ticketTarget();
  const run = (...args: string[]) => ["ticket", "act", REF, "correct_plan_decision", ...args];

  it("--answer sends free text and --alternative a chosen option, in decision order, on both requests", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("correct_plan_decision", target))],
      [EXECUTE]: [ok(executed("correct_plan_decision", target))],
    });
    const { code, body } = await cli(
      ctx,
      ...run(
        "--answer",
        "3=Use the existing queue, with a retry limit of 5 = enough",
        "--alternative",
        "1=postgres",
        "--answer",
        "0=Keep the endpoint",
        "--apply",
      ),
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    const plan_correction = {
      answers: [
        { decision: 0, free_text: "Keep the endpoint" },
        { decision: 1, alternative: "postgres" },
        { decision: 3, free_text: "Use the existing queue, with a retry limit of 5 = enough" },
      ],
    };
    expect(calls[1]?.body).toEqual({ action: "correct_plan_decision", target, plan_correction });
    expect(calls[2]?.body).toEqual({
      action: "correct_plan_decision",
      target,
      plan_correction,
      preview_digest: "sha256:preview-1",
      idempotency_key: actKey("correct_plan_decision"),
      acknowledgements: [],
    });
    expect(body.data).toMatchObject({ settled: true });
  });

  it("each answer carries exactly one of alternative and free_text", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("correct_plan_decision", target))],
    });
    await cli(ctx, ...run("--answer", "0=free", "--alternative", "1=option"));
    const answers = (calls[1]?.body as { plan_correction: { answers: object[] } }).plan_correction
      .answers;
    for (const answer of answers) {
      const keys = Object.keys(answer).filter((key) => key !== "decision");
      expect(keys).toHaveLength(1);
    }
  });

  it("a repeated --answer takes several decisions, and 50 are the most", async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => ["--answer", `${index}=text ${index}`]);
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("correct_plan_decision", target))],
    });
    const { code } = await cli(ctx, ...run(...fifty.flat()));
    expect(code).toBe(ExitCode.Ok);
    expect(
      (calls[1]?.body as { plan_correction: { answers: unknown[] } }).plan_correction.answers,
    ).toHaveLength(50);
  });

  it("a correction the server refuses exits 5 with PLAN_DECISION_NOT_OPEN and its message", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("correct_plan_decision", target))],
      [EXECUTE]: [refusal(409, "PLAN_DECISION_NOT_OPEN", "That plan decision is not open.")],
    });
    const { code, body } = await cli(ctx, ...run("--alternative", "4=keep", "--apply"));
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "PLAN_DECISION_NOT_OPEN",
      message: "That plan decision is not open.",
    });
  });
});

describe("pidgen ticket act request_delivery_changes", () => {
  const target = ticketTarget();

  it("--apply --note sends the note, which the execute requires", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("request_delivery_changes", target))],
      [EXECUTE]: [ok(executed("request_delivery_changes", target))],
    });
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "request_delivery_changes",
      "--note",
      "Cover the empty-input case.",
      "--apply",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toEqual({ action: "request_delivery_changes", target });
    expect(calls[2]?.body).toEqual({
      action: "request_delivery_changes",
      target,
      preview_digest: "sha256:preview-1",
      idempotency_key: actKey("request_delivery_changes"),
      acknowledgements: [],
      note: "Cover the empty-input case.",
    });
  });

  it("a missing note refused by the server exits 5 with FEEDBACK_REQUIRED", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(ANSWERS)],
      [PREVIEW]: [ok(preview("request_delivery_changes", target))],
      [EXECUTE]: [refusal(409, "FEEDBACK_REQUIRED", "Say what should change.")],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "request_delivery_changes",
      "--note",
      "x",
      "--apply",
    );
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "FEEDBACK_REQUIRED",
      message: "Say what should change.",
    });
  });
});

describe("usage errors of the plan, start, approve and override flags", () => {
  const ANSWER_FLAGS: Array<[string, string[]]> = [
    ["--exception-reason", ["--exception-reason", "Because."]],
    ["--criterion-status", ["--criterion-status", "passing"]],
    ["--override-reason", ["--override-reason", "Because."]],
    ["--answer", ["--answer", "0=text"]],
    ["--alternative", ["--alternative", "0=option"]],
  ];

  it.each(
    ANSWER_FLAGS.flatMap(([flag, args]) =>
      ["retry_run", "approve_delivery", "start_work", "snooze_reminders"].map(
        (action) => [flag, action, args] as const,
      ),
    ),
  )(
    "%s given for %s, which does not take it, exits 2 and sends nothing",
    async (flag, action, args) => {
      const { ctx, calls } = await setup();
      const { code, body } = await cli(ctx, "ticket", "act", REF, action, ...args);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
      expect(body.error?.message).toContain(flag);
      expect(body.error?.message).toContain(action);
      expect(calls).toEqual([]);
    },
  );

  it("a choice flag names the kind that takes it", async () => {
    const { ctx } = await setup();
    const exception = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_delivery",
      "--exception-reason",
      "x",
    );
    expect(exception.body.error?.message).toContain("approve_with_exception");
    const override = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "start_work",
      "--criterion-status",
      "passing",
    );
    expect(override.body.error?.message).toContain("override_acceptance_criterion");
    const answer = await cli(ctx, "ticket", "act", REF, "start_work", "--answer", "0=x");
    expect(answer.body.error?.message).toContain("correct_plan_decision");
  });

  it.each([
    [
      "approve_with_exception without --exception-reason",
      ["approve_with_exception"],
      "--exception-reason",
    ],
    [
      "approve_with_exception with a blank --exception-reason",
      ["approve_with_exception", "--exception-reason", "  "],
      "--exception-reason",
    ],
    [
      "override_acceptance_criterion without --criterion-status",
      ["override_acceptance_criterion", "--criterion", "0", "--override-reason", "Because."],
      "--criterion-status",
    ],
    [
      "override_acceptance_criterion without --override-reason",
      ["override_acceptance_criterion", "--criterion", "0", "--criterion-status", "passing"],
      "--override-reason",
    ],
    [
      "override_acceptance_criterion without either",
      ["override_acceptance_criterion", "--criterion", "0"],
      "--criterion-status",
    ],
    [
      "override_acceptance_criterion with a blank --override-reason",
      [
        "override_acceptance_criterion",
        "--criterion-status",
        "passing",
        "--override-reason",
        "   ",
      ],
      "--override-reason",
    ],
    [
      "correct_plan_decision without --answer or --alternative",
      ["correct_plan_decision"],
      "--answer",
    ],
    ["request_delivery_changes without --note", ["request_delivery_changes"], "--note"],
    [
      "request_delivery_changes --apply without --note",
      ["request_delivery_changes", "--apply"],
      "--note",
    ],
    [
      "request_delivery_changes with a blank --note",
      ["request_delivery_changes", "--note", "  "],
      "--note",
    ],
  ])("%s exits 2 and sends nothing", async (_, args, flag) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "act", REF, ...args);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toContain(flag);
    expect(calls).toEqual([]);
  });

  it("a missing required choice names the flag", async () => {
    const { ctx } = await setup();
    const exception = await cli(ctx, "ticket", "act", REF, "approve_with_exception");
    expect(exception.body.error?.message).toContain("--exception-reason");
    const override = await cli(ctx, "ticket", "act", REF, "override_acceptance_criterion");
    expect(override.body.error?.message).toContain("--criterion-status");
    expect(override.body.error?.message).toContain("--override-reason");
    const correction = await cli(ctx, "ticket", "act", REF, "correct_plan_decision");
    expect(correction.body.error?.message).toContain("--answer");
    expect(correction.body.error?.message).toContain("--alternative");
    const changes = await cli(ctx, "ticket", "act", REF, "request_delivery_changes");
    expect(changes.body.error?.message).toContain("--note");
  });

  it.each([
    [
      "an unknown --criterion-status",
      ["--criterion-status", "maybe", "--override-reason", "x"],
      "--criterion-status",
    ],
    [
      "--criterion-status in capitals",
      ["--criterion-status", "PASSING", "--override-reason", "x"],
      "--criterion-status",
    ],
    [
      "an overlong --override-reason",
      ["--criterion-status", "passing", "--override-reason", "r".repeat(2001)],
      "--override-reason",
    ],
  ])("override_acceptance_criterion with %s exits 2 and sends nothing", async (_, args, flag) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      ...args,
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain(flag);
    expect(calls).toEqual([]);
  });

  it("approve_with_exception with an overlong --exception-reason exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_with_exception",
      "--exception-reason",
      "r".repeat(2001),
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(body.error?.message).toContain("--exception-reason");
    expect(calls).toEqual([]);
  });

  it.each([
    ["no decision", ["--answer", "text"]],
    ["no text", ["--answer", "1="]],
    ["blank text", ["--answer", "1=   "]],
    ["a non-numeric decision", ["--answer", "first=text"]],
    ["a negative decision", ["--answer", "-1=text"]],
    ["a fractional decision", ["--answer", "1.5=text"]],
    ["an empty decision", ["--answer", "=text"]],
    ["an alternative with no option", ["--alternative", "1"]],
    ["an alternative with a blank option", ["--alternative", "1= "]],
    ["a non-numeric alternative decision", ["--alternative", "a=b"]],
    ["the same decision answered twice", ["--answer", "1=a", "--answer", "1=b"]],
    ["the same decision answered and chosen", ["--answer", "1=a", "--alternative", "1=b"]],
    [
      "more than 50 answers",
      Array.from({ length: 51 }, (_, index) => ["--answer", `${index}=text`]).flat(),
    ],
  ])("correct_plan_decision with %s exits 2 and sends nothing", async (_, args) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "act", REF, "correct_plan_decision", ...args);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    // Each is the CLI's own check of the answers, not a refusal to parse the flag.
    expect(body.error?.message).toMatch(
      /--answer|--alternative|Decision \d+ is answered|at most 50/,
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ["a negative --criterion", "-1"],
    ["a fractional --criterion", "1.5"],
    ["a non-numeric --criterion", "first"],
    ["an empty --criterion", ""],
    ["an exponent --criterion", "1e2"],
    ["a signed --criterion", "+1"],
    ["an enormous --criterion", "9".repeat(30)],
  ])("%s exits 2 and sends nothing", async (_, value) => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "override_acceptance_criterion",
      "--criterion",
      value,
    );
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "CLI_USAGE" } });
    expect(body.error?.message).toContain("--criterion");
    expect(calls).toEqual([]);
  });

  it("--apply with the wrong choices sends nothing, not even the listing", async () => {
    const { ctx, calls } = await setup();
    const { code } = await cli(
      ctx,
      "ticket",
      "act",
      REF,
      "approve_delivery",
      "--exception-reason",
      "x",
      "--apply",
    );
    expect(code).toBe(ExitCode.Usage);
    expect(calls).toEqual([]);
  });
});

it.each([40, 80, 120])("resource presentation: decisions at %s columns", async (columns) => {
  const { ctx, calls } = await setup({
    [LIST]: [ok(ACTIONS)],
    [SHOW]: [ok(detailWith({ workflow_attention: null }))],
  });
  ctx.io.stdoutColumns = columns;
  expect(await runCli(["ticket", "actions", REF, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  const output = ctx.out.join("");
  for (const value of [
    "Ticket actions",
    "Actions (4 displayed)",
    "blocked",
    "Refusal",
    "REPLAY_REQUIRES_PRODUCER",
    "Target",
    "run-2",
  ])
    expect(output).toContain(value);
  expect(calls.map(routeOf)).toEqual([LIST, SHOW]);
  expect(ctx.err).toEqual([]);
});

// c1-actions: the failure and its recommended action survive any terminal width.
it.each([40, 80, 120])(
  "resource presentation: a failed step's actions at %s columns",
  async (columns) => {
    const { ctx } = await setup({
      [LIST]: [ok(ACTIONS)],
      [SHOW]: [ok(detailWith({ workflow_attention: FAILED_ATTENTION }))],
    });
    const output = await actionsTable(ctx, columns);
    expect(output.split("\n")[1]).toMatch(/^Recommended action:/);
    for (const value of [
      "Retry the run",
      "Failed step:",
      "Fix:",
      "Who can fix it:",
      "Technical details",
      "GH006:",
      "Actions (4 displayed)",
    ])
      expect(output).toContain(value);
    expect(ctx.err).toEqual([]);
  },
);

it.each([40, 80, 120])(
  "action preview preserves effects without execution at %s columns",
  async (columns) => {
    const data = preview("retry_run", runTarget(), { acks: ["completed_source"] });
    const { ctx, calls } = await setup({
      [LIST]: [ok(ACTIONS), ok(ACTIONS)],
      [PREVIEW]: [ok(data), ok(data)],
    });
    ctx.io.stdoutColumns = columns;
    await expectMutationParity(
      ctx,
      calls,
      ["ticket", "act", REF, "retry_run", "--run", "run-2"],
      ["Preview — not applied.", "--ack completed_source", "fresh"],
    );
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
  },
);

/** The App Service's failure projection on a failed step (ADR-169 Decision 4), as a fixture. */
const FAILED_ATTENTION = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/failure-projection/workflow-attention-push-protected.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown> & {
  failure: { title: string; fix: string } & Record<string, unknown>;
};
const SHOW = `GET /api/v1/tickets/${REF}`;
const detailWith = (extra: Record<string, unknown>) => ({
  id: TICKET_ID,
  ticket_key: REF,
  stage: "in_execution",
  title: "Deliver the change",
  ...extra,
});
/** The projection recommending the second listed decision, so naming it first reorders the list. */
const REPLAY_FAILURE = { ...FAILED_ATTENTION.failure, recommended_action: "replay_from_node" };

async function actionsTable(ctx: TestContext, columns = 200): Promise<string> {
  ctx.out.length = 0;
  ctx.io.stdoutColumns = columns;
  expect(await runCli(["ticket", "actions", REF, "--format", "table"], ctx)).toBe(ExitCode.Ok);
  return ctx.out.join("");
}

describe("pidgen ticket actions explains a failed step", () => {
  // c1-actions
  it("names the projection's recommended action first, then the failure, then the decisions with it leading", async () => {
    const detail = detailWith({
      workflow_attention: { ...FAILED_ATTENTION, failure: REPLAY_FAILURE },
    });
    const { ctx, calls } = await setup({ [LIST]: [ok(ACTIONS)], [SHOW]: [ok(detail)] });
    const output = await actionsTable(ctx);
    const lines = output.split("\n");
    expect(lines[0]).toBe("Ticket actions");
    expect(lines[1]).toBe("Recommended action: Replay from this node (replay_from_node)");
    expect(output).toContain(`Failed step: ${String(REPLAY_FAILURE.title)}`);
    expect(output).toContain(`Fix: ${String(REPLAY_FAILURE.fix)}`);
    expect(output).toContain("Who can fix it: A repository administrator");
    expect(output).toContain("Technical details");
    const listed = output.slice(output.indexOf("Actions (4 displayed)"));
    expect(listed.indexOf("Replay from this node")).toBeGreaterThan(-1);
    expect(listed.indexOf("Replay from this node")).toBeLessThan(listed.indexOf("Retry the run"));
    expect(calls.map(routeOf)).toEqual([LIST, SHOW]);
    expect(ctx.err).toEqual([]);
  });

  // c1-actions
  it("names a recommended action the list does not offer by its kind", async () => {
    const failure = { ...FAILED_ATTENTION.failure, recommended_action: "reopen_for_delivery" };
    const detail = detailWith({ workflow_attention: { ...FAILED_ATTENTION, failure } });
    const { ctx } = await setup({ [LIST]: [ok(ACTIONS)], [SHOW]: [ok(detail)] });
    const output = await actionsTable(ctx);
    expect(output.split("\n")[1]).toBe("Recommended action: reopen_for_delivery");
  });

  // c1-actions
  it("a projection with no recommended action explains the failure and keeps the server's order", async () => {
    const failure = { ...FAILED_ATTENTION.failure, recommended_action: null };
    const detail = detailWith({ workflow_attention: { ...FAILED_ATTENTION, failure } });
    const { ctx } = await setup({ [LIST]: [ok(ACTIONS)], [SHOW]: [ok(detail)] });
    const output = await actionsTable(ctx);
    expect(output).not.toContain("Recommended action:");
    expect(output.split("\n")[1]).toBe(`Failed step: ${String(failure.title)}`);
    const listed = output.slice(output.indexOf("Actions (4 displayed)"));
    expect(listed.indexOf("Retry the run")).toBeLessThan(listed.indexOf("Replay from this node"));
  });

  // c1-json
  it("--format json carries the projection unchanged beside the server's decisions", async () => {
    const detail = detailWith({
      workflow_attention: { ...FAILED_ATTENTION, failure: REPLAY_FAILURE },
    });
    const { ctx } = await setup({ [LIST]: [ok(ACTIONS)], [SHOW]: [ok(detail)] });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data?.["failure"]).toEqual(REPLAY_FAILURE);
    // The decisions keep the server's order in JSON; only the human view leads with the recommendation.
    expect((body.data?.["actions"] as { action: string }[]).map((item) => item.action)).toEqual(
      ACTIONS.actions.map((item) => item.action),
    );
  });

  // c1-absent
  it.each([
    ["no workflow attention", ok(detailWith({ workflow_attention: null }))],
    [
      "an attention without a failure (an older App Service)",
      ok(detailWith({ workflow_attention: { ...FAILED_ATTENTION, failure: undefined } })),
    ],
    ["a ticket read the caller is refused", refusal(403, "FORBIDDEN", "You may not read it.")],
  ])("with %s, the actions render exactly as before", async (_, answer) => {
    const { ctx } = await setup({
      [LIST]: [ok(ACTIONS), ok(ACTIONS)],
      [SHOW]: [answer, answer.clone()],
    });
    const { code, body } = await cli(ctx, "ticket", "actions", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).not.toHaveProperty("failure");
    expect(Object.keys(body.data ?? {})).toEqual(["ticket_id", "actions"]);
    const output = await actionsTable(ctx);
    expect(output).toBe(`Ticket actions\n${renderDetails(body.data, 200)}\n`);
    expect(ctx.err).toEqual([]);
  });
});
