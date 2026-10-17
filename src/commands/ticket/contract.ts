import { Option, type Command } from "commander";
import {
  CONTRACT_ROUTES,
  contractArgument,
  contractRequest,
  contractSegment,
  type ContractLinkRequest,
} from "../../core/contracts.js";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec, CommandInput } from "../../core/registry.js";

type Link = ContractLinkRequest["link"];

function appendValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `<ref> <contract>`, the arguments every `ticket contract` verb takes. */
function linkArguments(command: Command): Command {
  return contractArgument(
    command.argument("<ref>", "the ticket: its key, e.g. ALPHA-40, or its id"),
  );
}

/** `<ref> <contract> [--operation <op>]...`, for implements and builds-against. */
function configureLink(command: Command): void {
  linkArguments(command).addOption(
    new Option(
      "--operation <op>",
      "an operation of the contract the work uses, e.g. 'GET /payments'; repeatable (default: all of them)",
    )
      .argParser(appendValue)
      .default([]),
  );
}

/**
 * Reads `<ref> <contract> [--operation <op>]...` into the ticket's path segment and the link's body.
 * A missing, empty, `.` or `..` ref, an empty contract or an empty `--operation` is a usage error
 * (exit code 2) and nothing is sent.
 */
function linkTarget(
  input: CommandInput,
  link: Link,
): { ticket: string; body: ContractLinkRequest } {
  const ticket = pathSegment("ticket ref", input.args[0]);
  const contract = input.args[1]?.trim() ?? "";
  if (contract === "") throw usageError("A contract is required.", { argument: "contract" });
  const given = (input.options["operation"] as string[] | undefined) ?? [];
  const operations = given.map((operation) => operation.trim());
  if (operations.some((operation) => operation === "")) {
    throw usageError("--operation needs an operation of the contract, e.g. 'GET /payments'.", {
      option: "--operation",
    });
  }
  return { ticket, body: { contract_id: contract, link, operations } };
}

function linkCommand(verb: string, link: Link, summary: string): CommandSpec {
  return {
    path: ["ticket", "contract", verb],
    summary,
    configure: configureLink,
    async run(ctx, input) {
      const { ticket, body } = linkTarget(input, link);
      return contractRequest(ctx, input.global, CONTRACT_ROUTES.link, { ticket_id: ticket }, body);
    },
  };
}

/**
 * `pidgen ticket contract implements <ref> <contract> [--operation <op>]...`: links a delivery root
 * in the contract's provider (or, for a domain's contract, a project the domain covers) to the
 * contract it implements (`POST /tickets/{ticket_id}/contracts` with
 * `{contract_id, link: implements, operations}`; no `--operation` sends `[]`, all of them). `data`
 * is the ticket's contracts (`contracts`), each link with its `key`, `link`, `operations` and
 * `criterion_id`: for an implements link, the acceptance criterion "implements {contract}" the
 * ticket gains. A link never blocks: it is not a dependency edge.
 *
 * The server's refusals write nothing and keep their codes and details: the seven link refusals
 * (`CONTRACT_LINK_NOT_DELIVERY_ROOT`, `CONTRACT_LINK_OUTSIDE_PROVIDER`, `CONTRACT_LINK_OWN_PROVIDER`,
 * `CONTRACT_LINK_INSIDE_COHORT`, `CONTRACT_DEPRECATED`, `CONTRACT_RETIRED`,
 * `CONTRACT_UNKNOWN_OPERATION`) exit 5 whatever their status; `TICKET_NOT_FOUND` and
 * `CONTRACT_NOT_FOUND` exit 4; a 403 exits 3.
 */
export const ticketContractImplements = linkCommand(
  "implements",
  "implements",
  "Link a delivery root to the contract it implements",
);

/**
 * `pidgen ticket contract builds-against <ref> <contract> [--operation <op>]...`: links a delivery
 * root or an Epic outside the contract's provider to the contract it builds against (the same route
 * and refusals as `implements`, with `link: builds_against`). `data` is the ticket's contracts; the
 * new link's `criterion_id` is null.
 */
export const ticketContractBuildsAgainst = linkCommand(
  "builds-against",
  "builds_against",
  "Link work to a contract it builds against",
);

/**
 * `pidgen ticket contract rm <ref> <contract>`: removes the ticket's link to the contract, whichever
 * it is (`DELETE /tickets/{ticket_id}/contracts/{contract_id}`, both percent-encoded path segments).
 * `data` is the ticket's remaining contracts. No such link is the server's
 * `CONTRACT_LINK_NOT_FOUND` (exit 4).
 */
export const ticketContractRm: CommandSpec = {
  path: ["ticket", "contract", "rm"],
  summary: "Remove a ticket's link to a contract",
  configure(command: Command) {
    linkArguments(command);
  },
  async run(ctx, { args, global }) {
    const ticket = pathSegment("ticket ref", args[0]);
    const contract = contractSegment(args.slice(1));
    return contractRequest(ctx, global, CONTRACT_ROUTES.unlink, {
      ticket_id: ticket,
      contract_id: contract,
    });
  },
};
