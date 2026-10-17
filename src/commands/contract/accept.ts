import type { Command } from "commander";
import {
  CONTRACT_ROUTES,
  contractArgument,
  contractSegment,
  sendContractRequest,
  type Contract,
} from "../../core/contracts.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import { wholeNumber } from "../ticket/history.js";

/**
 * `pidgen contract accept <contract> [--revision <n>]`: accepts a revision that waits for a person
 * (`POST /contracts/{contract_id}/revisions/{revision_number}/accept`, with no body). With
 * `--revision` that revision is accepted. Without it the contract is read first
 * (`GET /contracts/{contract_id}`) and its one waiting revision is accepted; when none waits it is
 * `NO_REVISION_WAITING` (exit 5, `error.details`: the `contract` and each revision's `number` and
 * `acceptance` in `statuses`), and when more than one waits `REVISIONS_WAITING` (exit 5, the
 * `waiting` numbers): give `--revision`. No accept is sent then. With automatic acceptance nothing
 * ever waits.
 *
 * `data` is the contract with the accepted revision. The server decides who may accept: a 403 (not
 * a Manager of the provider project, a maintainer of the provider domain, the owner, an Owner or an
 * Administrator, or the domains feature switched off for a domain's contract) exits 3. A revision
 * already accepted is the server's `CONTRACT_REVISION_NOT_WAITING`, and one a newer accepted
 * revision supersedes `CONTRACT_REVISION_SUPERSEDED` (both 409, exit 5). A `--revision` that is
 * not a whole number from 1 is a usage error (exit 2) and sends nothing.
 */
export const contractAccept: CommandSpec = {
  path: ["contract", "accept"],
  summary: "Accept a contract's waiting revision, or the one --revision names",
  configure(command: Command) {
    contractArgument(command).option(
      "--revision <n>",
      "the revision to accept (default: the one waiting revision)",
    );
  },
  async run(ctx, { args, options, global }) {
    const contract = contractSegment(args);
    const named = wholeNumber(options["revision"], "--revision", {
      min: 1,
      what: "a whole number from 1",
    });
    const session = await openSession(ctx, global);
    let number = named;
    if (number === undefined) {
      const { data } = await sendContractRequest<Contract>(session, CONTRACT_ROUTES.show, {
        contract_id: contract,
      });
      const waiting = data.revisions.filter((revision) => revision.acceptance === "waiting");
      if (waiting.length === 0) {
        throw new CliError(
          "NO_REVISION_WAITING",
          `No revision of ${data.key} waits to be accepted.`,
          ExitCode.Refused,
          {
            contract: data.key,
            statuses: data.revisions.map(({ number, acceptance }) => ({ number, acceptance })),
          },
        );
      }
      if (waiting.length > 1) {
        throw new CliError(
          "REVISIONS_WAITING",
          `More than one revision of ${data.key} waits; name one with --revision.`,
          ExitCode.Refused,
          { contract: data.key, waiting: waiting.map((revision) => revision.number) },
        );
      }
      number = waiting[0]!.number;
    }
    const { result } = await sendContractRequest(session, CONTRACT_ROUTES.accept, {
      contract_id: contract,
      revision_number: String(number),
    });
    return result;
  },
};
