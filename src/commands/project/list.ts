import type { components } from "../../generated/api.js";
import { readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

type Project = components["schemas"]["ProjectResource"];

/**
 * `pidgen project list`: the projects the caller may see in the Account (`GET /projects`). `data` is
 * the server's array of projects, each with its merge policy and ticket rollup.
 */
export const projectList: CommandSpec = {
  path: ["project", "list"],
  summary: "List the projects you can see in the Account",
  async run(ctx, { global }) {
    return readRoute<Project[]>(ctx, global, "/projects");
  },
};
