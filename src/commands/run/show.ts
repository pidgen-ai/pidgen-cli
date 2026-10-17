import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type RunResource = components["schemas"]["RunResource"];

/**
 * `pidgen run show <run>`: one workflow run of the Account (`GET /runs/{run_id}`). `data` is the
 * server's run unchanged: its summary fields, including `terminal_reason_code` (why it ended),
 * `liveness` (`state` — live, suspected, repairing or stranded — with the recovery count and limit
 * and the `cause`) and `stranded_cause`, and `nodes`, the latest status of each node that has an
 * attempt. An unknown run, or another Account's, is the server's `RUN_NOT_FOUND` (exit code 4).
 */
export const runShow: CommandSpec = {
  path: ["run", "show"],
  summary: "Show one run with its nodes, terminal reason and stranded state",
  configure(command: Command) {
    command.argument("<run>", "the run's id, e.g. WFR-…");
  },
  async run(ctx, { args, global }) {
    const run = pathSegment("run id", args[0]);
    return readRoute<RunResource>(ctx, global, `/runs/${run}`);
  },
};
