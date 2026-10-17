import { Option, type Command } from "commander";
import { readAllPages } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";
import { INTERVENTION_TYPES } from "../ticket/list.js";

type Ticket = components["schemas"]["TicketResource"];
type InterventionType = components["schemas"]["InterventionType"];

/** The queue `review list` reads when `--type` is not given: tickets parked on a question. */
export const DEFAULT_REVIEW_TYPE: InterventionType = "clarification_needed";

/**
 * `pidgen review list [--type <type>]`: the tickets waiting on a person — those with an open
 * intervention of the type (`GET /tickets?intervention=…`), newest first, every page followed to
 * the last as for `pidgen ticket list`. `--type` defaults to `clarification_needed`, the tickets a
 * person answers with `pidgen ticket clarify`; it accepts the document's `InterventionType` values.
 * An unknown type is a usage error (exit code 2) and sends nothing.
 */
export const reviewList: CommandSpec = {
  path: ["review", "list"],
  summary: "List the tickets waiting on a person",
  configure(command: Command) {
    command.addOption(
      new Option("--type <type>", "the open intervention the tickets wait on")
        .choices(INTERVENTION_TYPES)
        .default(DEFAULT_REVIEW_TYPE),
    );
  },
  async run(ctx, { options, global }) {
    const type = (options["type"] as InterventionType | undefined) ?? DEFAULT_REVIEW_TYPE;
    return readAllPages<Ticket>(ctx, global, "/tickets", { intervention: type });
  },
};
