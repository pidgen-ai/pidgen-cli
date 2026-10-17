import { Option, type Command } from "commander";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { usageError } from "../../core/errors.js";
import { readAllPages } from "../../core/read.js";
import type { CommandResult, CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";
import { documentEnum, givenKind, kindOption, type TicketKind } from "./kind.js";

type Ticket = components["schemas"]["TicketResource"];
type TicketStage = components["schemas"]["TicketStage"];
type InterventionType = components["schemas"]["InterventionType"];

/** The stages `--stage` accepts: the document's `TicketStage`. */
export const TICKET_STAGES = documentEnum<TicketStage>("TicketStage");
/** The intervention types `--intervention` accepts: the document's `InterventionType`. */
export const INTERVENTION_TYPES = documentEnum<InterventionType>("InterventionType");
/** The longest `--query` the server accepts (the `q` parameter's `maxLength`). */
export const QUERY_MAX_LENGTH = 200;

/** A string filter: trimmed, and a usage error (exit code 2) when empty. */
export function filterValue(flag: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === "") throw usageError(`${flag} needs a value.`, { option: flag });
  return trimmed;
}

/** The filters `ticket list` sends, each as the route's query parameter of the same name. */
export interface TicketFilters {
  stage?: TicketStage | undefined;
  project_id?: string | undefined;
  q?: string | undefined;
  intervention?: InterventionType | undefined;
  kind?: TicketKind | undefined;
}

/** Every page of `GET /tickets` with these filters; an absent filter is not sent. */
export function listTickets(
  ctx: RunContext,
  global: GlobalOptions,
  filters: TicketFilters,
): Promise<CommandResult & { data: Ticket[] }> {
  return readAllPages<Ticket>(ctx, global, "/tickets", { ...filters });
}

/**
 * `pidgen ticket list`: the tickets the caller may see in the Account (`GET /tickets`), newest first,
 * with every page followed to the last. Each filter is sent as the route's query parameter:
 * `--stage` as `stage`, `--project` as `project_id`, `--query` as `q`, `--intervention` as
 * `intervention` and `--kind` as `kind`. Without `--kind` the server leaves Epics out and lists
 * Stories and Tasks; `--kind epic` lists only Epics. An unknown stage, intervention type or kind,
 * an empty filter, or a query longer than the server accepts is a usage error (exit code 2) and
 * sends nothing.
 */
export const ticketList: CommandSpec = {
  path: ["ticket", "list"],
  summary: "List the tickets you can see in the Account; --kind epic lists Epics",
  configure(command: Command) {
    command
      .addOption(new Option("--stage <stage>", "only tickets in this stage").choices(TICKET_STAGES))
      .option("--project <id>", "only tickets of this project")
      .option("--query <text>", "case-insensitive search over key, id, title and objective")
      .addOption(
        new Option(
          "--intervention <type>",
          "only tickets waiting on an open intervention of this type",
        ).choices(INTERVENTION_TYPES),
      )
      .addOption(
        kindOption("only tickets of this kind; epic lists Epics, which are left out without it"),
      );
  },
  async run(ctx, { options, global }) {
    const query = filterValue("--query", options["query"]);
    if (query !== undefined && query.length > QUERY_MAX_LENGTH) {
      throw usageError(`--query is longer than ${QUERY_MAX_LENGTH} characters.`, {
        option: "--query",
        max_length: QUERY_MAX_LENGTH,
      });
    }
    return listTickets(ctx, global, {
      stage: options["stage"] as TicketStage | undefined,
      project_id: filterValue("--project", options["project"]),
      q: query,
      intervention: options["intervention"] as InterventionType | undefined,
      kind: givenKind(options),
    });
  },
};
