import { DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";
import { configurePerson } from "./member-add.js";

/**
 * `pidgen domain maintainer add <domain> <user-id>`: makes the person a Domain Maintainer, who
 * manages the domain and is also a member (`PUT /domains/{domain_id}/people/{user_id}` with
 * `{role: "maintainer"}`). `data` is the domain. `MEMBER_NOT_FOUND` exits 4.
 */
export const domainMaintainerAdd: CommandSpec = {
  path: ["domain", "maintainer", "add"],
  summary: "Make a person a Domain Maintainer",
  configure: configurePerson,
  async run(ctx, { args, global }) {
    const [domain_id, user_id] = pairSegments(args, "user id");
    return domainRequest(
      ctx,
      global,
      DOMAIN_ROUTES.personPut,
      { domain_id, user_id },
      { role: "maintainer" },
    );
  },
};
