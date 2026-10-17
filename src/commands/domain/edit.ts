import type { Command } from "commander";
import {
  DOMAIN_ROUTES,
  domainArgument,
  domainRequest,
  domainSegment,
  optionalText,
  type EditDomainRequest,
} from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain edit <domain> [--name <name>] [--key <KEY>]`: renames or rekeys a domain
 * (`PATCH /domains/{domain_id}` with the fields given). An edit with neither, or an empty one, is
 * `CLI_USAGE` (exit 2) and nothing is sent. Rekeying the Account domain once it holds an Epic is
 * the server's `DOMAIN_IS_ACCOUNT_ROOT` (exit 5).
 */
export const domainEdit: CommandSpec = {
  path: ["domain", "edit"],
  summary: "Rename or rekey a domain",
  configure(command: Command) {
    domainArgument(command)
      .option("--name <name>", "the new name")
      .option("--key <KEY>", "the new key: 3-6 uppercase letters or digits");
  },
  async run(ctx, { args, options, global }) {
    const domain_id = domainSegment(args);
    const body: EditDomainRequest = {};
    const name = optionalText(options, "name");
    const key = optionalText(options, "key");
    if (name !== undefined) body.name = name;
    if (key !== undefined) body.key = key;
    if (name === undefined && key === undefined) {
      throw usageError("Nothing to change: give --name, --key or both.", {
        options: ["--name", "--key"],
      });
    }
    return domainRequest(ctx, global, DOMAIN_ROUTES.edit, { domain_id }, body);
  },
};
