import { configurePair, DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain project add <domain> <project>`: the domain contains the project
 * (`PUT /domains/{domain_id}/projects/{project_ref}`). `data` is the domain.
 */
export const domainProjectAdd: CommandSpec = {
  path: ["domain", "project", "add"],
  summary: "Add a project to a domain",
  configure: configurePair("project", "the project: its id (proj-…) or ticket-key prefix"),
  async run(ctx, { args, global }) {
    const [domain_id, project_ref] = pairSegments(args, "project");
    return domainRequest(ctx, global, DOMAIN_ROUTES.projectAdd, { domain_id, project_ref });
  },
};
