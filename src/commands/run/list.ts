import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type RunSummary = components["schemas"]["RunSummary"];

/**
 * `pidgen run list <ref>`: the workflow runs of one ticket, newest first — highest attempt number,
 * ties by the latest start (`GET /tickets/{ref}/runs`). `data` is the server's array unchanged and
 * in its order: each run's `workflow_run_id`, `attempt_number`, `status`, `terminal_reason_code`,
 * `liveness` and the rest of its summary. A ticket with no runs is an empty array. The route is
 * not paged. An unknown ticket, or another Account's, is the server's `TICKET_NOT_FOUND` (exit
 * code 4).
 */
export const runList: CommandSpec = {
  path: ["run", "list"],
  summary: "List a ticket's workflow runs, newest first",
  configure(command: Command) {
    command.argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id");
  },
  async run(ctx, { args, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    return readRoute<RunSummary[]>(ctx, global, `/tickets/${ref}/runs`);
  },
};
