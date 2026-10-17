import type { Command } from "commander";
import {
  collect,
  DOMAIN_ROUTES,
  domainRequest,
  requiredText,
  type CreateDomainRequest,
} from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen domain create --name <name> --key <KEY> [--parent <domain>]...`: creates a domain
 * (`POST /domains` with `{name, key, parent_ids?}`). Without `--parent` the server puts it under
 * the Account domain. A missing or empty `--name` or `--key`, or an empty `--parent`, is
 * `CLI_USAGE` and a key that is not 3-6 uppercase letters or digits `INPUT_INVALID` (exit 2), and
 * nothing is sent. A key already taken is the server's 409 (exit 5).
 */
export const domainCreate: CommandSpec = {
  path: ["domain", "create"],
  summary: "Create a domain",
  configure(command: Command) {
    command
      .option("--name <name>", "the domain's name")
      .option("--key <KEY>", "the domain's key: 3-6 uppercase letters or digits")
      .option(
        "--parent <domain>",
        "a parent domain, by key or id; repeat for more (default: the Account domain)",
        collect,
      );
  },
  async run(ctx, { options, global }) {
    const body: CreateDomainRequest = {
      name: requiredText(options, "name"),
      key: requiredText(options, "key"),
    };
    const parents = (options["parent"] as string[] | undefined) ?? [];
    if (parents.length > 0) {
      body.parent_ids = parents.map((parent) => {
        const trimmed = parent.trim();
        if (trimmed === "") throw usageError("--parent needs a domain.", { option: "--parent" });
        return trimmed;
      });
    }
    return domainRequest(ctx, global, DOMAIN_ROUTES.create, {}, body);
  },
};
