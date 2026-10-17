import { DOMAIN_ROUTES, domainArgument, domainRequest, domainSegment } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain show <domain>`: one domain of the Account, by key or id
 * (`GET /domains/{domain_id}`). `data` is the domain as `domain list` shows it, and `granted`, the
 * people granted directly on it (`user_id`, `role`). An unknown domain, or another Account's, is
 * the server's `DOMAIN_NOT_FOUND` (exit 4).
 */
export const domainShow: CommandSpec = {
  path: ["domain", "show"],
  summary: "Show one domain: its parents, projects, domains and people counts",
  configure: domainArgument,
  async run(ctx, { args, global }) {
    return domainRequest(ctx, global, DOMAIN_ROUTES.show, { domain_id: domainSegment(args) });
  },
};
