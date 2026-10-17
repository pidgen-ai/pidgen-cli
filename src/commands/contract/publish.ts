import type { Command } from "commander";
import { publishBundle, readBundle, sourceKind, sourcePath } from "../../core/contract-publish.js";
import { collect, optionalText } from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen contract publish <file> (--project <project> | --domain <domain>) [--path <source path>]
 * [--commit <sha>] [--ref <ref>] [--include <glob>...] [--breaking] [--check]`: publishes a spec
 * file as the contract the Project or Domain provides at its source path
 * (`POST /projects/{project_ref}/contracts/publish` or `POST /domains/{domain_id}/contracts/publish`).
 * The first publish of a source path creates the contract, a later one revises it, and the same
 * resolved document again changes nothing.
 *
 * The CLI sends files, never schema text: `<file>` as the entry, and the files beside it, every
 * `.json`, `.yaml` and `.yml` file under the entry's directory (not under `node_modules` or a dot
 * directory), or with `--include` the files there matching its globs. Each is named by its path
 * relative to the entry's directory, so the App resolves relative `$ref`s among them. At most 200
 * files and 8 MiB in all (`FILE_TOO_LARGE`, exit 5, and nothing is sent). `source_path` is `--path`,
 * or the entry's path relative to the root of its git repository (outside one, `--path` is needed:
 * exit 2). `source_kind` is `ci` when `CI=true`, else `upload`. `--commit` and `--ref` name where
 * the file was read; `--breaking` records the change as breaking whatever comparing says.
 *
 * `--check` is the dry run for pull requests: it records nothing, exits 0 when the change is
 * additive or the file is unchanged, and on a breaking change exits 5 with
 * `CONTRACT_CHANGE_BREAKING` (`error.details.result` the dry run's answer) unless `--breaking` is
 * given. `data` is the server's answer: `outcome` (`created`, `revised` or `unchanged`), `dry_run`,
 * `contract_id` and `contract_key`, `revision`, `acceptance`, `change` (`additive` or `breaking`,
 * null when unchanged) with its `change_reason`, the file's `format`, `version`, `title` and
 * `source_path`, its `operation_count` and `type_count`, the operations `added` and `removed`, the
 * types `types_added` and `types_removed`, the pending operations it `landed` and those
 * `still_pending`, and the earlier refusals it resolves (`resolved_refusals`). A refused file
 * (`CONTRACT_FILE_INVALID`, `CONTRACT_FORMAT_UNSUPPORTED`, `CONTRACT_EXTERNAL_REF`,
 * `CONTRACT_CONVERSION_TIMEOUT`, `FILE_TOO_LARGE`) exits 5 and prints every error with its
 * location; a refusal that is not a dry run names its `refusal_id`.
 */
export const contractPublish: CommandSpec = {
  path: ["contract", "publish"],
  summary: "Publish a spec file, with the files beside it, as a Project's or a Domain's contract",
  configure(command: Command) {
    command
      .argument("<file>", "the spec file to publish, e.g. contracts/public-api/openapi.json")
      .option("--project <project>", "the provider Project: its key prefix, e.g. ALPHA, or its id")
      .option("--domain <domain>", "the provider Domain: its id (DOM-…)")
      .option(
        "--path <source path>",
        "the file's path in the repository (default: relative to the repository root)",
      )
      .option("--commit <sha>", "the commit the file was read at")
      .option("--ref <ref>", "the ref the commit was read from, e.g. refs/heads/main")
      .option(
        "--include <glob>",
        "send only the files beside the entry matching this glob (repeatable; default: every .json, .yaml and .yml file under its directory)",
        collect,
      )
      .option("--breaking", "record the change as breaking; with --check, accept a breaking change")
      .option("--check", "dry run: record nothing, and exit non-zero on a breaking change");
  },
  async run(ctx, { args, options, global }) {
    const provider = providerOption(options);
    const bundle = await readBundle(
      ctx,
      args[0] ?? "",
      (options["include"] as string[] | undefined) ?? [],
    );
    const path = await sourcePath(bundle.path, options["path"] as string | undefined);
    const commit = optionalText(options, "commit");
    const ref = optionalText(options, "ref");
    return publishBundle(ctx, global, {
      provider,
      bundle,
      source_path: path,
      source_kind: sourceKind(ctx),
      ...(commit !== undefined ? { commit } : {}),
      ...(ref !== undefined ? { ref } : {}),
      breaking: options["breaking"] === true,
      check: options["check"] === true,
    });
  },
};

/** Exactly one of `--project` and `--domain`, as a checked path segment. */
export function providerOption(
  options: Record<string, unknown>,
): { project: string } | { domain: string } {
  const project = optionalText(options, "project");
  const domain = optionalText(options, "domain");
  if ((project === undefined) === (domain === undefined)) {
    throw usageError("Give one of --project and --domain.", {
      options: ["--project", "--domain"],
    });
  }
  return project !== undefined
    ? { project: pathSegment("project", project) }
    : { domain: pathSegment("domain", domain) };
}
