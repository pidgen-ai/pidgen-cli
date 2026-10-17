import { DOMAIN_ROUTES, domainRequest, pairSegments } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";
import { configurePerson } from "./member-add.js";

/**
 * `pidgen domain maintainer rm <domain> <user-id>`: the person stops maintaining the domain and
 * stays a Domain Member (`PUT /domains/{domain_id}/people/{user_id}` with `{role: "member"}`).
 * `data` is the domain. To remove the person altogether, use `pidgen domain member rm`.
 */
export const domainMaintainerRm: CommandSpec = {
  path: ["domain", "maintainer", "rm"],
  summary: "Stop a person maintaining a domain; they stay a member",
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
