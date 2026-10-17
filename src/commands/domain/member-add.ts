import { configurePair, DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";

/** The `<domain> <user-id>` arguments of the member and maintainer commands. */
export const configurePerson = configurePair(
  "user-id",
  "the person's user id; they must be an active member of the Account",
);

/**
 * `pidgen domain member add <domain> <user-id>`: makes the person a Domain Member, who reads
 * everything in the projects the domain covers (`PUT /domains/{domain_id}/people/{user_id}` with
 * `{role: "member"}`). `data` is the domain. A person who is not an active member of the Account
 * is the server's `MEMBER_NOT_FOUND` (exit 4).
 */
export const domainMemberAdd: CommandSpec = {
  path: ["domain", "member", "add"],
  summary: "Make a person a Domain Member",
  configure: configurePerson,
  async run(ctx, { args, global }) {
    const [domain_id, user_id] = pairSegments(args, "user id");
    return domainRequest(
      ctx,
      global,
      DOMAIN_ROUTES.personPut,
      { domain_id, user_id },
      { role: "member" },
    );
  },
};
