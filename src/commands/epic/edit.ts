import type { Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import { editTicket } from "../ticket/edit.js";

/**
 * `pidgen epic edit <key> -f <file>`: an alias of `pidgen ticket edit <key> --kind epic -f <file>`.
 * The file holds only the fields of `EditTicketRequest` to change (`title`, `objective`,
 * `priority`, `merge_policy`, …; `merge_policy: null` makes the Epic inherit its project's policy
 * again). The CLI reads the Epic (`GET /tickets/{key}`) and sends its `version` with them in
 * `PATCH /tickets/{key}`. A body that does not parse or match, or names no field, is
 * `INPUT_INVALID` (exit code 2) and nothing is sent. A ticket that is not an Epic is
 * `TICKET_KIND_MISMATCH` and an unknown one the server's `TICKET_NOT_FOUND`; both exit 4.
 */
export const epicEdit: CommandSpec = {
  path: ["epic", "edit"],
  summary: "Edit an Epic from a JSON or YAML file (ticket edit --kind epic)",
  configure(command: Command) {
    command
      .argument("<key>", "the Epic's key, e.g. PIDGEN-12, or its id")
      .requiredOption(
        "-f, --file <file>",
        "the fields to change as JSON or YAML; - reads standard input",
      );
  },
  async run(ctx, { args, options, global }) {
    return editTicket(ctx, global, args[0], String(options["file"]), "epic");
  },
};
