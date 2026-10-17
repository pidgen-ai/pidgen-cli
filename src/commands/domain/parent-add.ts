import { configurePair, DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain parent add <domain> <parent-domain>`: the parent contains the domain
 * (`PUT /domains/{domain_id}/parents/{parent_id}`). `data` is the domain. `DOMAIN_CYCLE`,
 * `DOMAIN_TOO_DEEP` and `DOMAIN_IS_ACCOUNT_ROOT` exit 5.
 */
export const domainParentAdd: CommandSpec = {
  path: ["domain", "parent", "add"],
  summary: "Put a domain under another parent domain",
  configure: configurePair("parent-domain", "the parent domain: its key or id"),
  async run(ctx, { args, global }) {
    const [domain_id, parent_id] = pairSegments(args, "parent domain");
    return domainRequest(ctx, global, DOMAIN_ROUTES.parentAdd, { domain_id, parent_id });
  },
};
