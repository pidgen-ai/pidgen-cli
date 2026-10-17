import type { Command } from "commander";
import { proposeFragment, readBundle } from "../../core/contract-publish.js";
import { collect, optionalText } from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen contract propose <contract> <fragment> [--include <glob>...] [--check]` and
 * `pidgen contract propose --project <project> --title <title> <fragment> [--include <glob>...]
 * [--check]`: proposes a revision of a contract from a fragment file
 * (`POST /contracts/{contract_id}/proposals`), or a contract the Project is to provide that does
 * not exist yet (`POST /projects/{project_ref}/contracts/proposals`).
 *
 * The fragment is a file in the contract's format holding only the operations being added or
 * changed; the CLI sends it as it is, with the files beside it as `pidgen contract publish` sends
 * them (every `.json`, `.yaml` and `.yml` file under its directory, or with `--include` those
 * matching its globs), so its relative `$ref`s resolve, and the App takes its operations from it.
 * At most 200 files and 8 MiB in all (`FILE_TOO_LARGE`, exit 5, and nothing is sent). The proposed
 * revision is accepted under the Account's Contract approval, and its operations stay pending
 * until a published revision contains them. `--check` is the dry run: it records nothing.
 *
 * `data` is the server's answer: `dry_run`, `contract_id` and `contract_key`, `revision`,
 * `acceptance`, the fragment's `format`, `version` and `title`, its `operations`, those it made
 * `pending`, and those the newest published revision already has (`landed`). A refused
 * fragment exits 5 and prints every error with its location; an unknown contract is
 * `CONTRACT_NOT_FOUND` (exit 4). A contract with `--project`, `--project` without `--title`, or
 * `--title` without `--project` is a usage error (exit 2), and nothing is sent.
 */
export const contractPropose: CommandSpec = {
  path: ["contract", "propose"],
  summary: "Propose a revision of a contract, or a new contract, from a fragment file",
  configure(command: Command) {
    command
      .argument(
        "<contract or fragment>",
        "the contract (its key, e.g. CT-7, or its id); with --project, the fragment",
      )
      .argument("[fragment]", "the fragment file: only the operations being added or changed")
      .option(
        "--project <project>",
        "propose a contract this Project is to provide, which does not exist yet",
      )
      .option("--title <title>", "with --project, the new contract's title")
      .option(
        "--include <glob>",
        "send only the files beside the fragment matching this glob (repeatable; default: every .json, .yaml and .yml file under its directory)",
        collect,
      )
      .option("--check", "dry run: record nothing");
  },
  async run(ctx, { args, options, global }) {
    const project = optionalText(options, "project");
    const title = optionalText(options, "title");
    const check = options["check"] === true;
    const include = (options["include"] as string[] | undefined) ?? [];
    if (project !== undefined) {
      if (args.length !== 1) {
        throw usageError(
          "With --project, give only the fragment: the contract does not exist yet.",
          {
            option: "--project",
          },
        );
      }
      if (title === undefined) {
        throw usageError("A new contract's proposal needs its --title.", { option: "--title" });
      }
      const given = args[0]!;
      return proposeFragment(ctx, global, {
        target: { project: pathSegment("project", project), title },
        bundle: await readBundle(ctx, given, include, "<fragment>"),
        given,
        check,
      });
    }
    if (title !== undefined) {
      throw usageError("--title names a new contract; give it with --project.", {
        option: "--title",
      });
    }
    if (args.length !== 2) {
      throw usageError("Give the contract and the fragment file: propose <contract> <fragment>.", {
        arguments: ["<contract>", "<fragment>"],
      });
    }
    const contract = pathSegment("contract", args[0]);
    const given = args[1]!;
    return proposeFragment(ctx, global, {
      target: { contract },
      bundle: await readBundle(ctx, given, include, "<fragment>"),
      given,
      check,
    });
  },
};
