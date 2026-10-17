import type { Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import { filterValue, listTickets } from "../ticket/list.js";

/**
 * `pidgen epic list [--project <id>]`: an alias of `pidgen ticket list --kind epic`. The Epics the
 * caller may see in the Account (`GET /tickets?kind=epic`), with every page followed to the last.
 * `--project` is sent as `project_id`; an empty `--project` is a usage error (exit code 2) and
 * sends nothing. `data` is the array of Epics.
 */
export const epicList: CommandSpec = {
  path: ["epic", "list"],
  summary: "List the Epics you can see in the Account (ticket list --kind epic)",
  configure(command: Command) {
    command.option("--project <id>", "only Epics of this project");
  },
  async run(ctx, { options, global }) {
    return listTickets(ctx, global, {
      project_id: filterValue("--project", options["project"]),
      kind: "epic",
    });
  },
};
