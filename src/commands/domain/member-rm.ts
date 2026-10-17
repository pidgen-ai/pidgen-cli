import { DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";
import { configurePerson } from "./member-add.js";

/**
 * `pidgen domain member rm <domain> <user-id>`: removes the person from the domain, as a Member
 * and as a Maintainer (`DELETE /domains/{domain_id}/people/{user_id}`). `data` is the domain.
 */
export const domainMemberRm: CommandSpec = {
  path: ["domain", "member", "rm"],
  summary: "Remove a person from a domain",
  configure: configurePerson,
  async run(ctx, { args, global }) {
    const [domain_id, user_id] = pairSegments(args, "user id");
    return domainRequest(ctx, global, DOMAIN_ROUTES.personRm, { domain_id, user_id });
  },
};
