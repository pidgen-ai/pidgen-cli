import { configurePair, DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain parent rm <domain> <parent-domain>`: the parent stops containing the domain
 * (`DELETE /domains/{domain_id}/parents/{parent_id}`). `data` is the domain.
 * `DOMAIN_IS_ACCOUNT_ROOT` and `DOMAIN_COVERAGE_IN_USE` exit 5.
 */
export const domainParentRm: CommandSpec = {
  path: ["domain", "parent", "rm"],
  summary: "Remove a parent from a domain",
  configure: configurePair("parent-domain", "the parent domain: its key or id"),
  async run(ctx, { args, global }) {
    const [domain_id, parent_id] = pairSegments(args, "parent domain");
    return domainRequest(ctx, global, DOMAIN_ROUTES.parentRm, { domain_id, parent_id });
  },
};
