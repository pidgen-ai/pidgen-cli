import { Option, type Command } from "commander";
import { INSTRUCTION_KINDS, LIVE_DELIVERY_HELP } from "../../core/instructions.js";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type Instruction = components["schemas"]["Instruction"];

/**
 * `pidgen ticket instructions <ref> [--kind steer|request_changes]`: the instructions of one ticket
 * (`GET /tickets/{ref}/instructions`), across its sessions and in every state. `--kind` is sent as
 * `kind` and limits the list to steers or to requested changes; without it the CLI sends none. An
 * unknown kind, a missing option value, or a missing ticket is a usage error (exit code 2) and
 * sends nothing. `data` is the server's array unchanged: each instruction's `state` (the live
 * path's `dispatched` and `accepted` among them), its `mode`, the live path's times and, for an
 * instruction a running session returned, its `return_code`. An unknown ticket, or another Account's,
 * is `TICKET_NOT_FOUND` (exit code 4). The route needs a server that publishes steering
 * instructions; a server without it answers 404 (exit code 4). See docs/commands.md, "ticket".
 */
export const ticketInstructions: CommandSpec = {
  path: ["ticket", "instructions"],
  summary: "List a ticket's instructions: steers and requested changes",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .addOption(
        new Option("--kind <kind>", "only instructions of this kind").choices(INSTRUCTION_KINDS),
      )
      .addHelpText("after", LIVE_DELIVERY_HELP);
  },
  async run(ctx, { args, options, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    const kind = options["kind"] as (typeof INSTRUCTION_KINDS)[number] | undefined;
    return readRoute<Instruction[]>(
      ctx,
      global,
      `/tickets/${ref}/instructions`,
      kind === undefined ? undefined : { kind },
    );
  },
};
