import type { Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import { showTicket } from "../ticket/show.js";

/**
 * `pidgen epic show <key>`: an alias of `pidgen ticket show <key> --kind epic`. One Epic of the
 * Account by key (e.g. `PIDGEN-12`) or id (`GET /tickets/{key}`), with its `prerequisites`
 * (`GET /tickets/{key}/prerequisites`). An unknown ticket is the server's `TICKET_NOT_FOUND`, and
 * a ticket that is not an Epic is `TICKET_KIND_MISMATCH`; both exit 4.
 */
export const epicShow: CommandSpec = {
  path: ["epic", "show"],
  summary: "Show one Epic (ticket show --kind epic)",
  configure(command: Command) {
    command.argument("<key>", "the Epic's key, e.g. PIDGEN-12, or its id");
  },
  async run(ctx, { args, global }) {
    return showTicket(ctx, global, args[0], "epic");
  },
};
