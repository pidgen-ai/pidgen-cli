import type { Command } from "commander";
import {
  CONTRACT_ROUTES,
  contractArgument,
  contractRequest,
  contractSegment,
  readOptionFile,
} from "../../core/contracts.js";
import { usageError } from "../../core/errors.js";
import { readInput } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen contract revise <contract> -f <file> [--markdown <file.md>]`: adds a revision to a
 * contract (`POST /contracts/{contract_id}/revisions`). The file is the revision in JSON or YAML,
 * or standard input with `-f -`: `{kind, markdown, schema_format, change, operations?,
 * native_schema?}`, each operation `{name, types?}`. `--markdown` reads a Markdown file, relative
 * to the working directory, into `markdown`. The body is validated against the published
 * `ContractRevisionRequest` before anything is sent: a body that does not parse or match is
 * `INPUT_INVALID` (exit 2). A missing or empty `--markdown` file, or a file that names `markdown`
 * as well as `--markdown`, is a usage error (exit 2). Nothing is sent then.
 *
 * `data` is the contract with its new revision last; the revision's `acceptance` is `automatic`
 * when it was accepted at once, or `waiting` when the Account's Contract approval setting asks a
 * person to accept it (`pidgen contract accept`). A 403 (no Project role in the provider, not a Maintainer of the
 * provider domain, or the domains feature switched off for a domain's contract) exits 3; an
 * unknown contract is `CONTRACT_NOT_FOUND` (exit 4).
 */
export const contractRevise: CommandSpec = {
  path: ["contract", "revise"],
  summary: "Revise a contract from a JSON or YAML file; --markdown reads its text from a file",
  configure(command: Command) {
    contractArgument(command)
      .requiredOption(
        "-f, --file <file>",
        "the revision as JSON or YAML: kind, markdown, schema_format, change, operations, native_schema; - reads standard input",
      )
      .option(
        "--markdown <file.md>",
        "a Markdown file read into markdown, relative to the working directory",
      );
  },
  async run(ctx, { args, options, global }) {
    const contract = contractSegment(args);
    const input = await readInput(ctx, String(options["file"]));
    let body = input.value;
    const markdownFile = options["markdown"] as string | undefined;
    if (markdownFile !== undefined) {
      if (isRecord(body) && "markdown" in body) {
        throw usageError(`Give markdown in ${input.source} or with --markdown, not both.`, {
          option: "--markdown",
          source: input.source,
        });
      }
      const markdown = await readOptionFile(
        ctx,
        "--markdown",
        markdownFile,
        "a revision needs its text",
      );
      body = isRecord(body) ? { ...body, markdown } : body;
    }
    return contractRequest(ctx, global, CONTRACT_ROUTES.revise, { contract_id: contract }, body);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
