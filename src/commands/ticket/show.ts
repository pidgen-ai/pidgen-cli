import type { Command } from "commander";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { openSession } from "../../core/session.js";
import { pathSegment } from "../../core/read.js";
import type { CommandResult, CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";
import { givenKind, kindOption, requireKind, type TicketKind } from "./kind.js";

type TicketDetail = components["schemas"]["TicketDetailResource"];
type TicketPrerequisites = components["schemas"]["TicketPrerequisites"];

/**
 * One ticket by `ref` (`GET /tickets/{ref}`) with its `prerequisites`
 * (`GET /tickets/{ref}/prerequisites`). With `kind`, a ticket of another kind is
 * `TICKET_KIND_MISMATCH` (exit code 4) and the prerequisites are not requested.
 */
export async function showTicket(
  ctx: RunContext,
  global: GlobalOptions,
  rawRef: string | undefined,
  kind?: TicketKind,
): Promise<CommandResult> {
  const ref = pathSegment("ticket ref", rawRef);
  const session = await openSession(ctx, global);
  const ticket = await session.client.request<TicketDetail>({
    method: "GET",
    path: `/tickets/${ref}`,
  });
  requireKind(String(rawRef).trim(), ticket.data, kind, ticket.requestId);
  const prerequisites = await session.client.request<TicketPrerequisites>({
    method: "GET",
    path: `/tickets/${ref}/prerequisites`,
  });
  return {
    data: { ...ticket.data, prerequisites: prerequisites.data },
    meta: session.meta(ticket),
  };
}

/**
 * `pidgen ticket show <ref> [--kind <kind>]`: one ticket of the Account by key or id
 * (`GET /tickets/{ref}`), with its delivery, effective merge policy and open findings, and under
 * `prerequisites` whether it is ready to run and what holds it (`GET /tickets/{ref}/prerequisites`).
 * `meta` comes from the ticket's response. An unknown ticket, or another Account's, is the
 * server's `TICKET_NOT_FOUND` (exit code 4), and the prerequisites are not requested. With
 * `--kind` (e.g. `--kind epic`), a ticket of another kind is `TICKET_KIND_MISMATCH` (exit code 4).
 */
export const ticketShow: CommandSpec = {
  path: ["ticket", "show"],
  summary: "Show one ticket with its delivery, findings and prerequisites",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .addOption(kindOption("refuse the ticket unless it is of this kind, e.g. epic"));
  },
  async run(ctx, { args, options, global }) {
    return showTicket(ctx, global, args[0], givenKind(options));
  },
};
