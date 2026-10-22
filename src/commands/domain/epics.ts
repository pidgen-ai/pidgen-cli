import { Option, type Command } from "commander";
import { domainArgument, domainSegment } from "../../core/domains.js";
import { readDomainEpics } from "../../core/domain-epics.js";
import type { CommandSpec } from "../../core/registry.js";
import { wholeNumber } from "../ticket/history.js";

/** The Epics `--state` reads, as the route's `state` parameter lists them. */
export const DOMAIN_EPIC_STATES = ["open", "finished"] as const;

/** The largest page the domain Epics read answers. */
export const MAX_DOMAIN_EPICS_PER_PAGE = 50;

/**
 * `pidgen domain epics <domain> [--state open|finished] [--page <n>] [--per-page <n>]
 * [--no-subdomains]`: a domain's Initiatives (its Epics), and its subdomains' unless `--no-subdomains`
 * (`GET /domains/{domain_id}/epics`). `--state`, `--page`, `--per-page` and
 * `--no-subdomains` are sent as `state`, `page`, `per_page` and `subdomains=false`; a flag not given
 * is not sent, so the route's defaults apply (open Epics, subdomains included, 10 finished Epics a
 * page). `data` is the server's: `epics`, each with its `epic`, `domain_id`, its work grouped by
 * project in `projects` (`project` and `ticket_ids`) and `hidden`, the count of its Tickets you
 * cannot see; `tickets`, every Ticket the groups name; and `running`. A body that does not match
 * the published document is `UNEXPECTED_RESPONSE` (exit 1).
 *
 * A missing domain, an unknown `--state`, a `--page` that is not a whole number from 1, or a
 * `--per-page` outside 1 to 50 is a usage error (exit 2) and sends nothing. An unknown domain, or
 * another Account's, is the server's `DOMAIN_NOT_FOUND` (exit 4).
 */
export const domainEpics: CommandSpec = {
  path: ["domain", "epics"],
  summary: "List a domain's Initiatives, their work by project, and what you cannot see",
  configure(command: Command) {
    domainArgument(command)
      .addOption(
        new Option("--state <state>", "open Initiatives or finished ones (default: open)").choices(
          DOMAIN_EPIC_STATES,
        ),
      )
      .option("--page <n>", "the page of Initiatives to read, from 1")
      .option(
        "--per-page <n>",
        `Initiatives a page, 1 to ${MAX_DOMAIN_EPICS_PER_PAGE} (default: 10)`,
      )
      .option("--no-subdomains", "leave out the Initiatives of the domain's subdomains");
  },
  async run(ctx, { args, options, global }) {
    const domain = domainSegment(args);
    const page = wholeNumber(options["page"], "--page", {
      min: 1,
      what: "a whole number from 1",
    });
    const perPage = wholeNumber(options["perPage"], "--per-page", {
      min: 1,
      max: MAX_DOMAIN_EPICS_PER_PAGE,
      what: `a whole number from 1 to ${MAX_DOMAIN_EPICS_PER_PAGE}`,
    });
    return readDomainEpics(ctx, global, domain, {
      state: options["state"] as (typeof DOMAIN_EPIC_STATES)[number] | undefined,
      page,
      per_page: perPage,
      subdomains: options["subdomains"] === false ? false : undefined,
    });
  },
};
