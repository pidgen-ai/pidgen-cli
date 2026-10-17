import { DOMAIN_ROUTES, domainArgument, domainRequest, domainSegment } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/** `pidgen domain unarchive <domain>`: `PATCH /domains/{domain_id}` with `{archived: false}`. */
export const domainUnarchive: CommandSpec = {
  path: ["domain", "unarchive"],
  summary: "Unarchive a domain",
  configure: domainArgument,
  async run(ctx, { args, global }) {
    return domainRequest(
      ctx,
      global,
      DOMAIN_ROUTES.edit,
      { domain_id: domainSegment(args) },
      { archived: false },
    );
  },
};
