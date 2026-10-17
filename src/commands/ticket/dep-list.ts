import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type TicketDependencies = components["schemas"]["TicketDependencies"];

/**
 * `pidgen ticket dep list <ref>`: every dependency edge touching one ticket, in both directions
 * (`GET /tickets/{ref}/dependencies`). `data` is the server's answer unchanged: the ticket's
 * `ticket_id` and `ticket_key`, `blocked_by` (the tickets it waits for), `blocks` (the tickets
 * waiting for it) and `inherited_blocked_by` (`blocks` edges declared on its ancestors). An unknown
 * ticket, or another Account's, is the server's `TICKET_NOT_FOUND` (exit code 4).
 */
export const ticketDepList: CommandSpec = {
  path: ["ticket", "dep", "list"],
  summary: "List a ticket's dependencies in both directions",
  configure(command: Command) {
    command.argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id");
  },
  async run(ctx, { args, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    return readRoute<TicketDependencies>(ctx, global, `/tickets/${ref}/dependencies`);
  },
};
