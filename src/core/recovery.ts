import type { Command } from "commander";
import {
  blockedError,
  blockingRefusal,
  executeAction,
  fetchActions,
  MAX_NODE_ID,
  MAX_RUN_ID,
  matchesTarget,
  notOfferedError,
  optionalId,
  type ActionDecision,
} from "./actions.js";
import type { RunContext } from "./context.js";
import { usageError } from "./errors.js";
import type { ApiClient, ApiResponse } from "./http.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "./preview-options.js";
import { normalizeAcknowledgements } from "./preview.js";
import { ticketRef } from "./refs.js";
import type { CommandInput, CommandResult } from "./registry.js";
import { openSession } from "./session.js";

/**
 * Shared by `pidgen ticket retry` and `pidgen ticket replay`: one recovery of a ticket's workflow run
 * through the Ticket actions routes. The CLI reads the ticket's recovery decisions
 * (`GET /tickets/{ref}/actions?family=recovery`, narrowed by `run_id` and, for a replay,
 * `node_id`), picks the decision — `retry_run`, or `restart_refinement` when the `retry_run`
 * decision says to take it instead (a Refinery run) or the server offers only it; `replay_from_node`
 * for the node — and previews and executes it on `POST /tickets/{ref}/actions/preview` and
 * `POST /tickets/{ref}/actions/execute`. A blocked decision is refused before anything is
 * previewed. See docs/commands.md, "ticket retry and replay", and docs/preview-and-apply.md.
 */

export type RecoveryMode = "retry" | "replay";

export function addRecoveryOptions(command: Command, withNode: boolean): void {
  command.argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id");
  if (withNode) command.option("--node <id>", "the workflow node to replay from");
  command.option("--run <id>", "the run to recover (default: the run the server's decision names)");
  addPreviewApplyOptions(command);
}

export async function runRecovery(
  ctx: RunContext,
  input: CommandInput,
  command: string,
  mode: RecoveryMode,
): Promise<CommandResult> {
  const { args, options, global } = input;
  const ref = ticketRef(args[0]);
  const run = optionalId(options["run"], "--run", MAX_RUN_ID);
  const node = mode === "replay" ? requiredNode(options["node"]) : undefined;
  const previewApply = previewApplyOptionsFrom(ctx, { options, global });
  if (!previewApply.apply && previewApply.digest !== undefined) {
    throw usageError("--digest is only meaningful with --apply.");
  }
  normalizeAcknowledgements(previewApply.acknowledgements);

  const session = await openSession(ctx, global);
  let last: ApiResponse | null = null;
  const api: Pick<ApiClient, "request"> = {
    async request(request) {
      const response = await session.client.request(request);
      last = response;
      return response as never;
    },
  };
  const segment = encodeURIComponent(ref);

  const filter = {
    ...(run !== undefined ? { run } : {}),
    ...(node !== undefined ? { node } : {}),
  };
  const { data: listed } = await fetchActions(api, segment, { family: "recovery", ...filter });
  const decisions = listed.actions.filter((decision) => matchesTarget(decision, filter));
  const decision =
    mode === "retry"
      ? retryDecision(ref, decisions, listed.actions, filter)
      : replayDecision(ref, decisions, listed.actions, filter);

  const target = decision.target;
  const data = await executeAction(
    api,
    {
      command,
      target: [ref, target.run_id ?? "", ...(node !== undefined ? [node] : [])].join("/"),
      segment,
      decision,
      acknowledgements: "convention",
    },
    previewApply,
  );
  return { data, meta: session.meta(last) };
}

/**
 * `retry_run` for the run, unless its decision is blocked and names `restart_refinement` as the
 * action to take instead, or the server offers only `restart_refinement`: then that decision. The
 * server lists the newest run first, so without `--run` the first decision is the newest run's.
 */
function retryDecision(
  ref: string,
  decisions: ActionDecision[],
  offered: ActionDecision[],
  filter: { run?: string },
): ActionDecision {
  const retry = decisions.find((decision) => decision.action === "retry_run");
  const refinement = (runId: string | null | undefined) =>
    decisions.find(
      (decision) =>
        decision.action === "restart_refinement" &&
        (runId === undefined || decision.target.run_id === runId),
    );
  if (retry !== undefined) {
    const blocking = blockingRefusal(retry);
    if (blocking === null) return retry;
    if (blocking.refusal.instead === "restart_refinement") {
      const restart = refinement(retry.target.run_id);
      if (restart !== undefined) return allowed(ref, restart);
    }
    throw blockedError(ref, retry, blocking);
  }
  const restart = refinement(undefined);
  if (restart !== undefined) return allowed(ref, restart);
  throw notOfferedError(ref, "retry_run", filter, offered);
}

/** `replay_from_node` for the node (and the run, with `--run`). */
function replayDecision(
  ref: string,
  decisions: ActionDecision[],
  offered: ActionDecision[],
  filter: { run?: string; node?: string },
): ActionDecision {
  const replay = decisions.find((decision) => decision.action === "replay_from_node");
  if (replay === undefined) throw notOfferedError(ref, "replay_from_node", filter, offered);
  return allowed(ref, replay);
}

function allowed(ref: string, decision: ActionDecision): ActionDecision {
  const blocking = blockingRefusal(decision);
  if (blocking !== null) throw blockedError(ref, decision, blocking);
  return decision;
}

function requiredNode(value: unknown): string {
  const node = optionalId(value, "--node", MAX_NODE_ID);
  if (node === undefined) {
    throw usageError("pidgen ticket replay needs --node <id>, the workflow node to replay from.", {
      option: "--node",
    });
  }
  return node;
}
