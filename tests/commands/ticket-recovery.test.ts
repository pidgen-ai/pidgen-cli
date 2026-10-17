import { expectMutationParity } from "../support/context.js";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../../src/core/exit-codes.js";
import { deriveIdempotencyKey } from "../../src/core/preview.js";
import {
  ACTIONS_PATH,
  EXECUTE_PATH,
  PREVIEW_PATH,
  REF,
  SERVER,
  STATUS_PATH,
  cli,
  decision,
  executed,
  listing,
  nodeTarget,
  ok,
  preview,
  refusal,
  routeOf,
  runTarget,
  setup,
} from "../support/actions.js";

/**
 * `pidgen ticket retry` and `pidgen ticket replay` keep their flags but go through the Ticket actions
 * routes: they read the recovery decisions, then preview and execute `retry_run` (or
 * `restart_refinement`) and `replay_from_node`.
 */

const LIST = `GET ${ACTIONS_PATH}`;
const PREVIEW = `POST ${PREVIEW_PATH}`;
const EXECUTE = `POST ${EXECUTE_PATH}`;

const RECOVERY = listing(
  decision("retry_run", runTarget("run-2"), {
    recommended: "The run stranded; a fresh attempt is safe.",
  }),
  decision("retry_run", runTarget("run-1")),
  decision("replay_from_node", nodeTarget("implement", "run-2")),
);

const retryKey = (acks: string[] = [], digest = "sha256:preview-1", runId = "run-2") =>
  deriveIdempotencyKey({ command: "ticket retry", target: `${REF}/${runId}` }, digest, acks);

const replayKey = (node: string, acks: string[] = [], digest = "sha256:preview-1") =>
  deriveIdempotencyKey({ command: "ticket replay", target: `${REF}/run-2/${node}` }, digest, acks);

describe("pidgen ticket retry", () => {
  it("retry reads the recovery decisions and previews retry_run on the newest run, changing nothing", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [ok(preview("retry_run", runTarget("run-2")))],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        action: "retry_run",
        target: runTarget("run-2"),
        preview_digest: "sha256:preview-1",
        required_acknowledgements: [],
        consequence: { run: "fresh" },
        effects: { reexecuted_nodes: ["plan", "implement"] },
        decision: { action: "retry_run", label: "Retry the run" },
      },
      meta: { request_id: "req-example", profile: "default", account: "ACC-EXAMPLE" },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
    expect(calls[0]?.query).toEqual({ family: "recovery" });
    expect(calls[1]?.body).toEqual({ action: "retry_run", target: runTarget("run-2") });
    expect(calls[1]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
  });

  it("retry --run asks for that run's decisions and previews it, even if the server lists others", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [ok(preview("retry_run", runTarget("run-1")))],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "--run", "run-1");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ action: "retry_run", target: { run_id: "run-1" } });
    expect(calls[0]?.query).toEqual({ family: "recovery", run_id: "run-1" });
    expect(calls[1]?.body).toEqual({ action: "retry_run", target: runTarget("run-1") });
  });

  it("retry --apply --digest executes retry_run with the digest, reason and a derived key", async () => {
    const key = retryKey();
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [ok(executed("retry_run", runTarget("run-2")))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "retry",
      REF,
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--reason",
      "The stranded run cannot heal",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE]);
    expect(calls[1]?.body).toEqual({
      action: "retry_run",
      target: runTarget("run-2"),
      preview_digest: "sha256:preview-1",
      idempotency_key: key,
      acknowledgements: [],
      reason: "The stranded run cannot heal",
    });
    expect(calls[1]?.headers["x-pidgen-account"]).toBe("ACC-EXAMPLE");
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        settled: true,
        idempotency_key: key,
        result: {
          command_id: expect.any(String),
          ticket_id: "TKT-example",
          status: "applied",
          disposition_code: null,
          workflow_run_id: "run-3",
          status_url: expect.any(String),
          action: "retry_run",
        },
      },
      meta: { request_id: "req-example" },
    });
  });

  it("retry --apply without a digest executes a fresh preview that needs no acknowledgement", async () => {
    const key = retryKey();
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [ok(preview("retry_run", runTarget("run-2")))],
      [EXECUTE]: [ok(executed("retry_run", runTarget("run-2")))],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "--apply");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ settled: true, idempotency_key: key });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW, EXECUTE]);
    expect(calls[2]?.body).toMatchObject({ preview_digest: "sha256:preview-1" });
  });

  it("retry takes restart_refinement when the retry_run decision says to take it instead", async () => {
    const refinery = listing(
      decision("retry_run", runTarget("run-2"), {
        blocked: {
          code: "REFINERY_RESTART_REQUIRED",
          message: "A Refinery run restarts refinement instead.",
          instead: "restart_refinement",
        },
      }),
      decision("restart_refinement", runTarget("run-2"), { recommended: "Refinery run" }),
    );
    const { ctx, calls } = await setup({
      [LIST]: [ok(refinery)],
      [PREVIEW]: [ok(preview("restart_refinement", runTarget("run-2")))],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({ action: "restart_refinement" });
    expect(calls[1]?.body).toEqual({ action: "restart_refinement", target: runTarget("run-2") });
  });

  it("retry takes restart_refinement when the server offers only that", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(listing(decision("restart_refinement", runTarget("run-2"))))],
      [PREVIEW]: [ok(preview("restart_refinement", runTarget("run-2")))],
    });
    const { code } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({ action: "restart_refinement" });
  });

  it("retry of a blocked retry_run exits 5 with the refusal's code, message and instead, previewing nothing", async () => {
    const blocked = listing(
      decision("retry_run", runTarget("run-2"), {
        blocked: {
          code: "REFINERY_SELECTIVE_REPLAY_REQUIRED",
          message: "A Refinery run recovers by replaying a node.",
          instead: "replay_from_node",
        },
      }),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(blocked)] });
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "--run", "run-2");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "REFINERY_SELECTIVE_REPLAY_REQUIRED",
        message: "A Refinery run recovers by replaying a node.",
        details: { action: "retry_run", blocked_by: "admissible", instead: "replay_from_node" },
      },
    });
    expect(body.error?.details["next"]).toContain(`pidgen ticket act ${REF} replay_from_node`);
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("retry the caller may not take exits 3 with the authorization refusal", async () => {
    const forbidden = listing(
      decision("retry_run", runTarget("run-2"), {
        unauthorized: { code: "FORBIDDEN", message: "You may not retry runs.", instead: null },
      }),
    );
    const { ctx, calls } = await setup({ [LIST]: [ok(forbidden)] });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "You may not retry runs.",
      details: { blocked_by: "authorized", instead: null },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("retry when no run can be retried exits 5 with ACTION_NOT_OFFERED", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(listing(decision("replay_from_node", nodeTarget("implement"))))],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "ACTION_NOT_OFFERED",
      details: { action: "retry_run", offered: [{ action: "replay_from_node" }] },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("retry of an unknown ticket exits 4 and previews nothing", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [refusal(404, "TICKET_NOT_FOUND", "No such ticket.")],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.NotFound);
    expect(body).toMatchObject({ ok: false, data: null, error: { code: "TICKET_NOT_FOUND" } });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("retry whose preview the server refuses keeps its code and exits 5", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [refusal(409, "ACTIVE_ATTEMPT_EXISTS", "The run already has an active attempt.")],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "ACTIVE_ATTEMPT_EXISTS",
      message: "The run already has an active attempt.",
    });
  });

  it("retry with an actions answer that is not a decision list exits 1", async () => {
    const { ctx } = await setup({ [LIST]: [ok({ ticket_id: "TKT-example", actions: "none" })] });
    const { code, body } = await cli(ctx, "ticket", "retry", REF);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });

  it("retry execute refused with PREVIEW_STALE exits 6 and says to preview again", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [refusal(409, "PREVIEW_STALE", "The decision changed since the preview.")],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "retry",
      REF,
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("PREVIEW_STALE");
    expect(body.error?.details["next"]).toContain("Preview again");
  });
});

describe("pidgen ticket replay", () => {
  it("replay reads the node's recovery decisions and previews replay_from_node, changing nothing", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [ok(preview("replay_from_node", nodeTarget("implement")))],
    });
    const { code, body } = await cli(ctx, "ticket", "replay", REF, "--node", "implement");
    expect(code).toBe(ExitCode.Ok);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        action: "replay_from_node",
        target: nodeTarget("implement"),
        preview_digest: "sha256:preview-1",
        effects: { reexecuted_nodes: ["implement", "verify"], reused_nodes: ["plan"] },
        decision: { action: "replay_from_node" },
      },
      meta: { request_id: "req-example" },
    });
    expect(calls.map(routeOf)).toEqual([LIST, PREVIEW]);
    expect(calls[0]?.query).toEqual({ family: "recovery", node_id: "implement" });
    expect(calls[1]?.body).toEqual({ action: "replay_from_node", target: nodeTarget("implement") });
  });

  it("replay --run previews the node of that run", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [
        ok(
          listing(
            decision("replay_from_node", nodeTarget("verify", "run-2")),
            decision("replay_from_node", nodeTarget("verify", "run-1")),
          ),
        ),
      ],
      [PREVIEW]: [ok(preview("replay_from_node", nodeTarget("verify", "run-1")))],
    });
    const { code } = await cli(ctx, "ticket", "replay", REF, "--node", "verify", "--run", "run-1");
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ family: "recovery", run_id: "run-1", node_id: "verify" });
    expect(calls[1]?.body).toEqual({
      action: "replay_from_node",
      target: nodeTarget("verify", "run-1"),
    });
  });

  it("replay --apply executes replay_from_node with the digest and a derived key", async () => {
    const key = replayKey("implement");
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [ok(executed("replay_from_node", nodeTarget("implement")))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "replay",
      REF,
      "--node",
      "implement",
      "--run",
      "run-2",
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE]);
    expect(calls[1]?.body).toEqual({
      action: "replay_from_node",
      target: nodeTarget("implement"),
      preview_digest: "sha256:preview-1",
      idempotency_key: key,
      acknowledgements: [],
    });
    expect(body.data).toMatchObject({
      settled: true,
      idempotency_key: key,
      result: { status: "applied", action: "replay_from_node" },
    });
  });

  it("replay of a blocked node exits 5 with REPLAY_REQUIRES_PRODUCER and nothing previewed", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [
        ok(
          listing(
            decision("replay_from_node", nodeTarget("verify"), {
              blocked: {
                code: "REPLAY_REQUIRES_PRODUCER",
                message: "Replay the producer node implement instead.",
                instead: "replay_from_node",
              },
            }),
          ),
        ),
      ],
    });
    const { code, body } = await cli(ctx, "ticket", "replay", REF, "--node", "verify");
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "REPLAY_REQUIRES_PRODUCER",
        message: "Replay the producer node implement instead.",
        details: { target: nodeTarget("verify") },
      },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("replay of a node with no decision exits 5 with ACTION_NOT_OFFERED", async () => {
    const { ctx, calls } = await setup({ [LIST]: [ok(RECOVERY)] });
    const { code, body } = await cli(ctx, "ticket", "replay", REF, "--node", "nope");
    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "ACTION_NOT_OFFERED",
      details: { action: "replay_from_node", node_id: "nope" },
    });
    expect(calls.map(routeOf)).toEqual([LIST]);
  });

  it("replay preview refused with REPLAY_NODE_NOT_FOUND exits 4", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [refusal(404, "REPLAY_NODE_NOT_FOUND", "No such node.")],
    });
    const { code, body } = await cli(ctx, "ticket", "replay", REF, "--node", "implement");
    expect(code).toBe(ExitCode.NotFound);
    expect(body.error?.code).toBe("REPLAY_NODE_NOT_FOUND");
  });
});

describe("pidgen ticket retry and replay: acknowledgements", () => {
  it("applying without a digest when the preview requires an acknowledgement exits 6", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [ok(preview("retry_run", runTarget(), { acks: ["ambiguous_effects"] }))],
    });
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "--apply");
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "DIGEST_REQUIRED",
        details: { preview: { required_acknowledgements: ["ambiguous_effects"] } },
      },
    });
    expect(calls.map(routeOf)).not.toContain(EXECUTE);
  });

  it("the server's ACKNOWLEDGEMENT_REQUIRED refusal on execute exits 6 naming the --ack", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [
        refusal(409, "ACKNOWLEDGEMENT_REQUIRED", "An acknowledgement is missing.", {
          missing: ["ambiguous_effects"],
        }),
      ],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "replay",
      REF,
      "--node",
      "implement",
      "--apply",
      "--digest",
      "sha256:preview-1",
    );
    expect(code).toBe(ExitCode.ConfirmationRequired);
    expect(body.error?.code).toBe("ACKNOWLEDGEMENT_REQUIRED");
    expect(body.error?.details["next"]).toContain("--ack ambiguous_effects");
  });

  it("applying with --ack ambiguous-effects sends the acknowledgement", async () => {
    const key = retryKey(["ambiguous_effects"]);
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [ok(executed("retry_run", runTarget()))],
    });
    const { code, body } = await cli(
      ctx,
      "ticket",
      "retry",
      REF,
      "--run",
      "run-2",
      "--apply",
      "--digest",
      "sha256:preview-1",
      "--ack",
      "ambiguous-effects",
    );
    expect(code).toBe(ExitCode.Ok);
    expect(calls[1]?.body).toMatchObject({
      acknowledgements: ["ambiguous_effects"],
      idempotency_key: key,
    });
    expect(body.data).toMatchObject({ settled: true, idempotency_key: key });
  });
});

describe("pidgen ticket retry and replay --wait", () => {
  const applyRetry = ["ticket", "retry", REF, "--apply", "--digest", "sha256:preview-1"];

  it("--wait follows the execute's status_url until it settles", async () => {
    const key = retryKey();
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [ok(executed("retry_run", runTarget(), { status: "applying" }), 202)],
      [`GET ${STATUS_PATH}`]: [
        ok(executed("retry_run", runTarget(), { status: "applying" }), 202),
        ok(executed("retry_run", runTarget())),
      ],
    });
    const { code, body } = await cli(ctx, ...applyRetry, "--wait");
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE, `GET ${STATUS_PATH}`, `GET ${STATUS_PATH}`]);
    expect(body).toMatchObject({
      ok: true,
      data: { settled: true, idempotency_key: key, result: { status: "applied" } },
    });
    expect(ctx.err).toEqual([]);
  });

  it("--wait follows a relative status_url on the configured server", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [
        ok(executed("retry_run", runTarget(), { status: "applying", statusUrl: STATUS_PATH }), 202),
      ],
      [`GET ${STATUS_PATH}`]: [ok(executed("retry_run", runTarget()))],
    });
    const { code } = await cli(ctx, ...applyRetry);
    expect(code).toBe(ExitCode.Ok);
    expect(calls.map(routeOf)).toContain(`GET ${STATUS_PATH}`);
  });

  it("--no-wait returns the applying execute and the status route to follow", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [ok(executed("retry_run", runTarget(), { status: "applying" }), 202)],
    });
    const { code, body } = await cli(ctx, ...applyRetry, "--no-wait");
    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      settled: false,
      handle: STATUS_PATH,
      result: { status: "applying", status_url: `${SERVER}${STATUS_PATH}` },
    });
    expect(calls.map(routeOf)).toEqual([LIST, EXECUTE]);
  });

  it("--wait without a status_url to follow exits 1", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [
        ok(executed("retry_run", runTarget(), { status: "applying", statusUrl: null }), 202),
      ],
    });
    const { code, body } = await cli(ctx, ...applyRetry);
    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error?.code).toBe("UNEXPECTED_RESPONSE");
  });

  it("--wait reports a refusal from the status route and exits 5", async () => {
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [ok(executed("retry_run", runTarget(), { status: "applying" }), 202)],
      [`GET ${STATUS_PATH}`]: [
        refusal(409, "RECOVERY_DEFINITION_MISSING", "The run's workflow definition is gone."),
      ],
    });
    const { code, body } = await cli(ctx, ...applyRetry);
    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({ ok: false, error: { code: "RECOVERY_DEFINITION_MISSING" } });
  });

  it("--wait gives up at --timeout with exit 8, leaving the action running", async () => {
    const applying = () => ok(executed("retry_run", runTarget(), { status: "applying" }), 202);
    const { ctx } = await setup({
      [LIST]: [ok(RECOVERY)],
      [EXECUTE]: [applying()],
      [`GET ${STATUS_PATH}`]: [applying(), applying(), applying()],
    });
    const { code, body } = await cli(ctx, "--timeout", "4", ...applyRetry);
    expect(code).toBe(ExitCode.Network);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", details: { handle: STATUS_PATH } },
    });
  });
});

describe("pidgen ticket retry and replay: usage errors", () => {
  it("usage: ticket replay without --node exits 2 and sends nothing", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "replay", REF);
    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "CLI_USAGE", details: { option: "--node" } },
    });
    expect(calls).toEqual([]);
  });

  it("usage: an empty --node exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "replay", REF, "--node", " ");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("usage: a missing ticket reference exits 2", async () => {
    for (const verb of [["retry"], ["replay", "--node", "implement"]]) {
      const { ctx, calls } = await setup();
      const { code, body } = await cli(ctx, "ticket", ...verb);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
      expect(calls).toEqual([]);
    }
  });

  it("usage: a malformed ticket reference exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "retry", "../PIDGEN-4");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("usage: an empty or overlong --run exits 2", async () => {
    for (const value of ["", "r".repeat(129)]) {
      const { ctx, calls } = await setup();
      const { code, body } = await cli(ctx, "ticket", "retry", REF, "--run", value);
      expect(code).toBe(ExitCode.Usage);
      expect(body).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
      expect(calls).toEqual([]);
    }
  });

  it("a --run of 128 characters, the most the actions route's run_id filter accepts, is sent", async () => {
    const run = "r".repeat(128);
    const { ctx, calls } = await setup({
      [LIST]: [ok(listing(decision("retry_run", runTarget(run))))],
      [PREVIEW]: [ok(preview("retry_run", runTarget(run)))],
    });
    const { code } = await cli(ctx, "ticket", "retry", REF, "--run", run);
    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.query).toEqual({ family: "recovery", run_id: run });
  });

  it("usage: --digest without --apply exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "--digest", "sha256:preview-1");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("usage: a malformed --ack code exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "--apply", "--ack", "not a code");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("usage: an extra argument exits 2", async () => {
    const { ctx, calls } = await setup();
    const { code, body } = await cli(ctx, "ticket", "retry", REF, "PIDGEN-5");
    expect(code).toBe(ExitCode.Usage);
    expect(body.error?.code).toBe("CLI_USAGE");
    expect(calls).toEqual([]);
  });

  it("retry calls only the actions routes, not the recovery routes", async () => {
    const { ctx, calls } = await setup({
      [LIST]: [ok(RECOVERY)],
      [PREVIEW]: [ok(preview("retry_run", runTarget()))],
    });
    await cli(ctx, "ticket", "retry", REF);
    expect(calls.every((call) => call.path.startsWith(ACTIONS_PATH))).toBe(true);
  });
});

// AC-2a7583a429a3 / AC-2e443d6f3bc5 / AC-2e82c79f28be.
it.each([40, 80, 120])(
  "recovery mutation states preserve execution at %s columns",
  async (columns) => {
    for (const state of ["preview", "acknowledgement", "settled", "pending", "timeout"] as const) {
      const applying = () => ok(executed("retry_run", runTarget(), { status: "applying" }), 202);
      const { ctx, calls } = await setup({
        [LIST]: [ok(RECOVERY), ok(RECOVERY)],
        [PREVIEW]: [
          ok(preview("retry_run", runTarget(), { acks: ["completed_source"] })),
          ok(preview("retry_run", runTarget(), { acks: ["completed_source"] })),
        ],
        [EXECUTE]:
          state === "settled"
            ? [ok(executed("retry_run", runTarget())), ok(executed("retry_run", runTarget()))]
            : [applying(), applying()],
        [`GET ${STATUS_PATH}`]: [applying(), applying()],
      });
      ctx.io.stdoutColumns = columns;
      const argv = ["ticket", "retry", REF];
      if (state !== "preview") argv.push("--apply");
      if (!["preview", "acknowledgement"].includes(state))
        argv.push("--digest", "sha256:preview-1", "--ack", "completed_source");
      if (state === "pending") argv.push("--no-wait");
      if (state === "timeout") argv.push("--timeout", "1");
      const fragments =
        state === "preview"
          ? ["Preview — not applied.", "--ack completed_source"]
          : state === "acknowledgement"
            ? ["DIGEST_REQUIRED", "--ack completed_source"]
            : state === "settled"
              ? ["Applied — settled."]
              : state === "pending"
                ? ["Accepted — still pending.", STATUS_PATH]
                : ["Wait timed out — still pending.", STATUS_PATH];
      const exit =
        state === "timeout"
          ? ExitCode.Network
          : state === "acknowledgement"
            ? ExitCode.ConfirmationRequired
            : ExitCode.Ok;
      const json = await expectMutationParity(ctx, calls, argv, fragments, exit);
      expect(json.ok).toBe(exit === ExitCode.Ok);
      expect(calls.map(routeOf)).toEqual(
        state === "preview" || state === "acknowledgement"
          ? [LIST, PREVIEW]
          : state === "timeout"
            ? [LIST, EXECUTE, `GET ${STATUS_PATH}`]
            : [LIST, EXECUTE],
      );
    }
  },
);
