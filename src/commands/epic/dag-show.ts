import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type TicketDependencyGraph = components["schemas"]["TicketDependencyGraph"];

/**
 * `pidgen epic dag show <key>`: an Epic's dependency graph, the ordinary ticket graph
 * (`GET /tickets/{key}/dependencies/graph`) by key (e.g. `PIDGEN-12`) or id. `data` is the
 * server's graph unchanged: the Epic (`ticket_id`, `ticket_key`), the tickets it depends on and
 * that depend on it as `nodes` with the `edges` between them, and its members as `pieces` with the
 * `piece_edges` between them. An unknown ticket is the server's `TICKET_NOT_FOUND` (exit code 4).
 */
export const epicDagShow: CommandSpec = {
  path: ["epic", "dag", "show"],
  summary: "Show an Epic's dependency graph: its members and the edges between them",
  configure(command: Command) {
    command.argument("<key>", "the Epic's key, e.g. PIDGEN-12, or its id");
  },
  async run(ctx, { args, global }) {
    const key = pathSegment("epic key", args[0]);
    return readRoute<TicketDependencyGraph>(ctx, global, `/tickets/${key}/dependencies/graph`);
  },
};
