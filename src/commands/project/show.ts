import type { Command } from "commander";
import type { components } from "../../generated/api.js";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

type Project = components["schemas"]["ProjectResource"];

/**
 * `pidgen project show <key>`: one project of the Account, by id or ticket-key prefix
 * (`GET /projects/{project_ref}`), including its merge policy. An unknown project, or another
 * Account's, is the server's `PROJECT_NOT_FOUND` (exit code 4).
 */
export const projectShow: CommandSpec = {
  path: ["project", "show"],
  summary: "Show one project, including its merge policy",
  configure(command: Command) {
    command.argument("<key>", "the project's id (proj-…) or ticket-key prefix, e.g. Pidgen");
  },
  async run(ctx, { args, global }) {
    const key = pathSegment("project key", args[0]);
    return readRoute<Project>(ctx, global, `/projects/${key}`);
  },
};
