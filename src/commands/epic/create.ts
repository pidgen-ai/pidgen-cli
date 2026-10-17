import type { Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import { createTicket, DOMAIN_OPTION, givenDomain } from "../ticket/create.js";

/**
 * `pidgen epic create -f <file>`: an alias of `pidgen ticket create --kind epic -f <file>`. An Epic
 * is an epic-kind Ticket: the file is a `CreateTicketRequest` (`title`, `project_id`, and an
 * Epic's `description` or `objective`, `branch_mode`, `feature_branch`, `target_date`,
 * `merge_policy`, `priority`), sent to `POST /tickets` with `kind: epic`. A body that does not
 * parse or match, or names another kind, is `INPUT_INVALID` (exit code 2) and nothing is sent.
 * `data` is the created Epic. A server refusal keeps its code, e.g. `PROJECT_NOT_FOUND` (exit
 * code 4) or `EPIC_FIELD_REFUSED` (exit code 2).
 *
 * `--domain <domain>` files a Domain Epic, as `pidgen ticket create --domain` does: `domain_id`
 * instead of `project_id`, and no `branch_mode` or `feature_branch`.
 */
export const epicCreate: CommandSpec = {
  path: ["epic", "create"],
  summary: "Create an Epic from a JSON or YAML file (ticket create --kind epic)",
  configure(command: Command) {
    command
      .requiredOption("-f, --file <file>", "the Epic as JSON or YAML; - reads standard input")
      .option(...DOMAIN_OPTION);
  },
  async run(ctx, { options, global }) {
    return createTicket(ctx, global, String(options["file"]), "epic", givenDomain(options));
  },
};
