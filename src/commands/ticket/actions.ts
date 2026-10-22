import { Option } from "commander";
import {
  ACTION_FAMILIES,
  describeDecision,
  fetchActions,
  matchesTarget,
  targetFilterFrom,
  type ActionFamily,
} from "../../core/actions.js";
import { ticketFailure } from "../../core/failure.js";
import type { ApiClient } from "../../core/http.js";
import { ticketRef } from "../../core/refs.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen ticket actions <ref> [--family <f>] [--run <id>] [--node <id>] [--prerequisite <id>]
 * [--decision <key>]`: the actions the ticket, its runs, its declared dependencies and the
 * decisions waiting on a person allow (`GET /tickets/{ref}/actions`, with `family`, `run_id`,
 * `node_id` and `prerequisite_id` passed through as filters; the families are `recovery`,
 * `run_control`, `ticket_control`, `decision_followup` and `decision_answers`). `--decision` keeps the actions whose
 * target names that `decision_key`; the route publishes no filter for it, so the CLI applies it to
 * the answer. `data` is `{ticket_id, actions}`; each action is the server's decision unchanged —
 * `label`, `target`, `admissible`, `authorized`, `recommended`, `consequence`,
 * `requires_preview` — with `state` (`allowed` or `blocked`), `blocked_by`, the blocking `refusal`
 * (its `code`, `message` and the action to take `instead`) and `recommended_reason`. When the
 * ticket's step failed, `failure` is the App Service's failure projection from the ticket
 * (`GET /tickets/{ref}`), unchanged, and the terminal view names its recommended action first;
 * it is absent when the ticket carries none or cannot be read. Reads only.
 * See docs/commands.md, "ticket actions and act".
 */
export const ticketActions: CommandSpec = {
  path: ["ticket", "actions"],
  summary: "List the actions a ticket and its runs allow, and which one is recommended",
  configure(command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .addOption(
        new Option("--family <family>", "only this family of actions").choices([
          ...ACTION_FAMILIES,
        ]),
      )
      .option("--run <id>", "only the actions on this run")
      .option("--node <id>", "only the actions on this node")
      .option("--prerequisite <id>", "only the actions on the dependency on this prerequisite")
      .option("--decision <decision_key>", "only the actions on this decision");
  },
  async run(ctx, { args, options, global }) {
    const ref = ticketRef(args[0]);
    const filter = targetFilterFrom(options);
    const family = options["family"] as ActionFamily | undefined;
    const session = await openSession(ctx, global);
    const { data, response } = await fetchActions(session.client, encodeURIComponent(ref), {
      ...(family !== undefined ? { family } : {}),
      ...filter,
    });
    const { decision } = filter;
    const actions =
      decision === undefined
        ? data.actions
        : data.actions.filter((item) => matchesTarget(item, { decision }));
    const failure = await readTicketFailure(session.client, encodeURIComponent(ref));
    return {
      data: {
        ...data,
        actions: actions.map(describeDecision),
        ...(failure !== undefined ? { failure } : {}),
      },
      meta: session.meta(response),
    };
  },
};

/**
 * The failure projection of the ticket's failed step, read from the ticket
 * (`GET /tickets/{ref}`) exactly as the server sent it. Undefined when the ticket carries none, as
 * an older App Service never does, or when the ticket cannot be read: the actions stand without it.
 */
async function readTicketFailure(
  api: Pick<ApiClient, "request">,
  segment: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const ticket = await api.request<unknown>({ method: "GET", path: `/tickets/${segment}` });
    return ticketFailure(ticket.data);
  } catch {
    return undefined;
  }
}
