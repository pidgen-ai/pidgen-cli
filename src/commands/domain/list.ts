import { DOMAIN_ROUTES, domainRequest } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain list`: the domains of the Account you may read, the Account domain first
 * (`GET /domains`). `data` is the server's array of domains, each with its `id`, `key`, `name`,
 * `is_account_root`, `archived`, `parents`, contained `projects` and `domains`, its people counts
 * (`people.members`, `people.maintainers`) and its Epic counts (`epics.open`, `epics.total`). A
 * body that does not match the published document is `UNEXPECTED_RESPONSE` (exit 1).
 */
export const domainList: CommandSpec = {
  path: ["domain", "list"],
  summary: "List the domains you can read in the Account",
  async run(ctx, { global }) {
    return domainRequest(ctx, global, DOMAIN_ROUTES.list);
  },
};
