import { Option, type Command } from "commander";
import { readAllPages } from "../../core/read.js";
import { presentIntent } from "../../core/requests.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";
import { filterValue } from "../ticket/list.js";

type IntakeRequest = components["schemas"]["IntakeRequest"];

/**
 * The states `--state` accepts: the ones `GET /intents` lists. A request that is `creating` is
 * between answering and becoming a ticket, and is not a state the list takes.
 */
export const REQUEST_LIST_STATES = [
  "clarifying",
  "created",
  "withdrawn",
] as const satisfies readonly IntakeRequest["state"][];

/**
 * `pidgen intent list [--project <ref>] [--state clarifying|created|withdrawn]`: the intake requests
 * the caller may see in the Account (`GET /intents`), with every page followed to the last as for
 * `pidgen ticket list`. `--project` is sent as `project_id` and `--state` as `state`; without
 * `--state` the request carries none and the server lists the requests waiting on answers
 * (`clarifying`). An unknown state, an empty `--project`, or an argument is a usage error (exit
 * code 2) and sends nothing. Each request is named by its key (`REQ-{n}`) in `request_id`, and by
 * its id only when it has none. The route needs a server that publishes durable requests; a server
 * without it answers 404 (exit code 4). See docs/commands.md, "intent".
 */
export const intentList: CommandSpec = {
  path: ["intent", "list"],
  summary: "List intake requests: those waiting on answers, or created or withdrawn ones",
  configure(command: Command) {
    command
      .option("--project <ref>", "only requests of this project, by id or ticket-key prefix")
      .addOption(
        new Option("--state <state>", "which requests to list (default: clarifying)").choices(
          REQUEST_LIST_STATES,
        ),
      );
  },
  async run(ctx, { options, global }) {
    const result = await readAllPages<IntakeRequest>(ctx, global, "/intents", {
      project_id: filterValue("--project", options["project"]),
      state: options["state"] as (typeof REQUEST_LIST_STATES)[number] | undefined,
    });
    return { ...result, data: presentIntent(result.data) };
  },
};
