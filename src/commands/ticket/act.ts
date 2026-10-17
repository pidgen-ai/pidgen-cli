import { Option } from "commander";
import {
  ACTION_FAMILIES,
  actionKeyTarget,
  actionKind,
  blockedError,
  blockingRefusal,
  choicesFrom,
  executeAction,
  fetchActions,
  followUpFrom,
  matchesTarget,
  noteFrom,
  notOfferedError,
  targetFilterFrom,
  type ActionFamily,
} from "../../core/actions.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiClient, ApiResponse } from "../../core/http.js";
import { addPreviewApplyOptions, previewApplyOptionsFrom } from "../../core/preview-options.js";
import { normalizeAcknowledgements } from "../../core/preview.js";
import { ticketRef } from "../../core/refs.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen ticket act <ref> <action> [--family <f>] [--run <id>] [--node <id>] [--fan-out-key <key>]
 * [--prerequisite <id>] [--criterion <index>] [--decision <key>] [--until <date-time>]
 * [--delegate-to <user_id>] [--exception-reason <text>] [--criterion-status <status>
 * --override-reason <text>] [--answer <decision>=<text>] [--alternative <decision>=<option>]
 * [--reason <text>] [--note <text>]`: finds the ticket's decision for the
 * action and target (`GET /tickets/{ref}/actions`, the flags passed as its filters), refuses a
 * blocked one with its refusal's code and message, and previews it
 * (`POST /tickets/{ref}/actions/preview`), printing its consequence, effects and required
 * acknowledgements. With `--apply` and `--acknowledge <code>...` it executes that preview
 * (`POST /tickets/{ref}/actions/execute`) with its `preview_digest`, the acknowledgements,
 * `--reason`, `--note` and a derived idempotency key, following a `202`'s `status_url` with
 * `--wait`. `remove_dependency` acts on a declared dependency, named with `--prerequisite`; the
 * decision follow-up actions act on a decision waiting on a person, named with `--decision`.
 * `--until` (snooze_reminders, defer_decision, keep_holding) and `--delegate-to`
 * (delegate_decision) are sent as `followup` on the preview and the execute alike, and given with
 * any other action are a usage error. The plan, start, approve and override actions take their
 * choices the same way: `--exception-reason` (approve_with_exception, sent as `exception`),
 * `--criterion-status` with `--override-reason` (override_acceptance_criterion, sent as
 * `criterion_override`, the criterion named with `--criterion`) and `--answer` or `--alternative`,
 * repeatable (correct_plan_decision, sent as `plan_correction`); one given for another action, or
 * left out of the action that requires it, is a usage error, and so is request_delivery_changes
 * without its `--note`. See docs/commands.md, "ticket actions and act".
 */
export const ticketAct: CommandSpec = {
  path: ["ticket", "act"],
  summary: "Preview, then with --apply take one of a ticket's actions",
  configure(command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .argument(
        "<action>",
        "the action, e.g. retry_run, replay_from_node, remove_dependency or hold_decision",
      )
      .addOption(
        new Option("--family <family>", "only this family of actions").choices([
          ...ACTION_FAMILIES,
        ]),
      )
      .option("--run <id>", "the run the action acts on")
      .option("--node <id>", "the node the action acts on")
      .option("--fan-out-key <key>", "the fan-out item the action acts on")
      .option("--prerequisite <id>", "the prerequisite ticket of the dependency the action acts on")
      .option(
        "--criterion <index>",
        "the acceptance criterion the action acts on, by its position in the list, counting from 0",
      )
      .option("--decision <decision_key>", "the decision the action acts on")
      .option(
        "--until <date-time>",
        "when to remind again, defer to or review the hold, as an ISO 8601 date-time with an offset; for snooze_reminders, defer_decision and keep_holding",
      )
      .option("--delegate-to <user_id>", "who to delegate the decision to; for delegate_decision")
      .option(
        "--exception-reason <text>",
        "why to approve although criteria are not proven; required by approve_with_exception",
      )
      .addOption(
        new Option(
          "--criterion-status <status>",
          "the status to set the criterion to; required by override_acceptance_criterion, with --override-reason",
        ).choices(["passing", "failing", "pending"]),
      )
      .option(
        "--override-reason <text>",
        "why to set the criterion to that status; required by override_acceptance_criterion, with --criterion-status",
      )
      .addOption(
        new Option(
          "--answer <decision=text>",
          "answer plan decision <decision> in your own words; repeatable; for correct_plan_decision, which needs --answer or --alternative",
        )
          .argParser(appendValue)
          .default([]),
      )
      .addOption(
        new Option(
          "--alternative <decision=option>",
          "answer plan decision <decision> with one of its options; repeatable; for correct_plan_decision",
        )
          .argParser(appendValue)
          .default([]),
      )
      .option(
        "--note <text>",
        "a note recorded with the executed action; required by request_delivery_changes: what should change",
      )
      .addOption(
        new Option(
          "--acknowledge <code...>",
          "acknowledge conditions the preview lists (same as --ack)",
        ),
      );
    addPreviewApplyOptions(command);
  },
  async run(ctx, { args, options, global }) {
    const ref = ticketRef(args[0]);
    const action = actionKind(args[1]);
    const filter = targetFilterFrom(options);
    const followup = followUpFrom(action, options);
    const choices = choicesFrom(action, options);
    const family = options["family"] as ActionFamily | undefined;
    const note = noteFrom(action, options);
    const previewApply = previewApplyOptionsFrom(ctx, { options, global });
    const acknowledge = options["acknowledge"];
    if (Array.isArray(acknowledge)) {
      previewApply.acknowledgements = [
        ...previewApply.acknowledgements,
        ...acknowledge.filter((code): code is string => typeof code === "string"),
      ];
    }
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

    const { data: listed } = await fetchActions(api, segment, {
      ...(family !== undefined ? { family } : {}),
      ...filter,
    });
    const candidates = listed.actions.filter(
      (decision) => decision.action === action && matchesTarget(decision, filter),
    );
    const decision = candidates[0];
    if (decision === undefined) throw notOfferedError(ref, action, filter, listed.actions);
    const targets = new Set(candidates.map((candidate) => JSON.stringify(candidate.target)));
    if (targets.size > 1) {
      throw new CliError(
        "ACTION_TARGET_AMBIGUOUS",
        `Ticket ${ref} offers ${action} on ${targets.size} targets; name one with --run, --node, --fan-out-key, --prerequisite, --criterion or --decision.`,
        ExitCode.Usage,
        { action, targets: candidates.map((candidate) => candidate.target) },
      );
    }
    const blocking = blockingRefusal(decision);
    if (blocking !== null) throw blockedError(ref, decision, blocking);

    const data = await executeAction(
      api,
      {
        command: "ticket act",
        target: actionKeyTarget(ref, action, decision.target),
        segment,
        decision,
        acknowledgements: "explicit",
        ...(note !== undefined ? { note } : {}),
        ...(followup !== undefined ? { followup } : {}),
        ...(Object.keys(choices).length > 0 ? { choices } : {}),
      },
      previewApply,
    );
    return { data, meta: session.meta(last) };
  },
};

function appendValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}
