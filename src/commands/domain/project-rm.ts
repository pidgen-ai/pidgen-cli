import { configurePair, DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain project rm <domain> <project>`: the domain stops containing the project
 * (`DELETE /domains/{domain_id}/projects/{project_ref}`). `data` is the domain. While open work
 * under the domain's Epics sits in the project the server refuses with `DOMAIN_COVERAGE_IN_USE`
 * (exit 5), its details naming the work you can see by key and counting the rest.
 */
export const domainProjectRm: CommandSpec = {
  path: ["domain", "project", "rm"],
  summary: "Remove a project from a domain",
  configure: configurePair("project", "the project: its id (proj-…) or ticket-key prefix"),
  async run(ctx, { args, global }) {
    const [domain_id, project_ref] = pairSegments(args, "project");
    return domainRequest(ctx, global, DOMAIN_ROUTES.projectRm, { domain_id, project_ref });
  },
};
