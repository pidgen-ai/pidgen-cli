import { DOMAIN_ROUTES, domainArgument, domainRequest, domainSegment } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain archive <domain>`: archives a domain (`PATCH /domains/{domain_id}` with
 * `{archived: true}`). The Account domain is `DOMAIN_IS_ACCOUNT_ROOT` and a domain with an open
 * Epic `DOMAIN_HAS_OPEN_EPICS`; both exit 5.
 */
export const domainArchive: CommandSpec = {
  path: ["domain", "archive"],
  summary: "Archive a domain",
  configure: domainArgument,
  async run(ctx, { args, global }) {
    return domainRequest(
      ctx,
      global,
      DOMAIN_ROUTES.edit,
      { domain_id: domainSegment(args) },
      { archived: true },
    );
  },
};
