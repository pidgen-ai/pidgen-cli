import type { Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type TicketDetail = components["schemas"]["TicketDetailResource"];
type TicketRecord = components["schemas"]["TicketRecord"];
type TicketEditMeta = components["schemas"]["TicketEditMeta"];

/** The option key where `ticket move` records which of `--epic` and `--no-epic` were given. */
const GIVEN = "epicFlagsGiven";

/**
 * `pidgen ticket move <ref> --epic <key> | --no-epic`: moves a ticket into the Epic `--epic` names
 * (its key, e.g. `PIDGEN-12`, or its id), or out of its Epic with `--no-epic`, by setting the
 * ticket's `parent_ticket_id`: the CLI reads the ticket (`GET /tickets/{ref}`) for its `version`
 * and sends `PATCH /tickets/{ref}` with `version` and `parent_ticket_id` (the Epic, or `null`). The
 * Epic must be in the ticket's own project. `data` is the ticket as the move left it, with
 * `admission` (the server's edit `meta`, or `null`) and `move`: `moved`,
 * `previous_parent_ticket_id` and `parent_ticket_id`. Exactly one of `--epic` and `--no-epic` is
 * required; both, or neither, is a usage error (exit code 2) and nothing is sent. The server's
 * refusals keep their codes: `TICKET_NOT_FOUND` exits 4, `FORBIDDEN` exits 3, `CONFLICT` exits 5,
 * and `PARENT_PROJECT_MISMATCH`, `PARENT_NOT_EPIC`, `EPIC_HAS_NO_PARENT` and
 * `PARENT_CHANGE_NOT_DELIVERY_ROOT` exit 2.
 */
export const ticketMove: CommandSpec = {
  path: ["ticket", "move"],
  summary: "Move a ticket into an Epic (--epic) or out of its Epic (--no-epic)",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .option("--epic <key>", "the Epic to move it into: its key, e.g. PIDGEN-12, or its id")
      .option("--no-epic", "take it out of its Epic");
    // commander stores --epic and --no-epic in one value, the last one given wins; record each
    // flag as it is parsed so that giving both is refused rather than silently resolved.
    for (const flag of ["epic", "no-epic"]) {
      command.on(`option:${flag}`, () => {
        const given = (command.getOptionValue(GIVEN) as string[] | undefined) ?? [];
        command.setOptionValue(GIVEN, [...given, `--${flag}`]);
      });
    }
  },
  async run(ctx, { args, options, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    const parent = moveTarget(options);
    const session = await openSession(ctx, global);
    const current = await session.client.request<TicketDetail>({
      method: "GET",
      path: `/tickets/${ref}`,
    });
    const version = current.data?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        `The server's ticket ${args[0]?.trim()} has no version to move against.`,
        ExitCode.Unexpected,
        { request_id: current.requestId },
      );
    }
    const previous = current.data?.parent_ticket_id ?? null;
    const response = await session.client.request<TicketRecord>({
      method: "PATCH",
      path: `/tickets/${ref}`,
      body: { version, parent_ticket_id: parent },
    });
    const admission = (response.meta ?? null) as TicketEditMeta | null;
    const now = response.data?.parent_ticket_id ?? null;
    return {
      data: {
        ...response.data,
        admission,
        move: {
          moved: now !== previous,
          previous_parent_ticket_id: previous,
          parent_ticket_id: now,
        },
      },
      meta: session.meta(response),
    };
  },
};

/** The `parent_ticket_id` to send: `--epic`'s key, or `null` for `--no-epic`. */
function moveTarget(options: Record<string, unknown>): string | null {
  const given = new Set((options[GIVEN] as string[] | undefined) ?? []);
  if (given.has("--epic") && given.has("--no-epic")) {
    throw usageError("Give --epic <key> or --no-epic, not both.", {
      options: ["--epic", "--no-epic"],
    });
  }
  if (given.has("--no-epic")) return null;
  if (!given.has("--epic")) {
    throw usageError("Give --epic <key> to move the ticket into an epic, or --no-epic.", {
      options: ["--epic", "--no-epic"],
    });
  }
  const key = typeof options["epic"] === "string" ? options["epic"].trim() : "";
  if (key === "") throw usageError("--epic needs an epic key or id.", { option: "--epic" });
  return key;
}
