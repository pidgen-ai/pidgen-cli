import type { Command } from "commander";
import { CONTRACT_ROUTES, contractRequest } from "../../core/contracts.js";
import { optionalText } from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen contract list (--project <project> | --domain <domain>)`: a project's or a domain's
 * contracts (`GET /projects/{project_ref}/contracts` or `GET /domains/{domain_id}/contracts`).
 * `data` is the server's. For a project: `provides`, its own contracts, and `builds_against`, the
 * contracts its work builds against from outside it. For a domain: `own`, the contracts the domain
 * itself provides; `coverage`, its covered projects' contracts grouped by `provider`; and
 * `builds_against`. Each entry is the contract without its revisions or linked work: its `provider`
 * (`project_id`, `kind`, `domain_id`, `key`, `name`), `owner_user_id`, `status`, the
 * `newest_accepted_revision` and the `waiting_revisions`. A body that does not match the published
 * document is `UNEXPECTED_RESPONSE` (exit 1).
 *
 * Exactly one of `--project` and `--domain` is given: both, neither or an empty one is a usage
 * error (exit 2) and sends nothing. An unknown project is `PROJECT_NOT_FOUND` and an unknown domain
 * `DOMAIN_NOT_FOUND` (exit 4).
 */
export const contractList: CommandSpec = {
  path: ["contract", "list"],
  summary: "List a project's or a domain's contracts, and those its work builds against",
  configure(command: Command) {
    command
      .option("--project <project>", "the project: its key prefix, e.g. ALPHA, or its id")
      .option("--domain <domain>", "the domain: its key, e.g. PAY, or its id (dom-…)");
  },
  async run(ctx, { options, global }) {
    const project = optionalText(options, "project");
    const domain = optionalText(options, "domain");
    if ((project === undefined) === (domain === undefined)) {
      throw usageError("Give one of --project and --domain.", {
        options: ["--project", "--domain"],
      });
    }
    if (project !== undefined) {
      return contractRequest(ctx, global, CONTRACT_ROUTES.projectList, {
        project_ref: pathSegment("project", project),
      });
    }
    return contractRequest(ctx, global, CONTRACT_ROUTES.domainList, {
      domain_id: pathSegment("domain", domain),
    });
  },
};
