import { Option, type Command } from "commander";
import { optionalText, requiredText } from "../../core/domains.js";
import { usageError } from "../../core/errors.js";
import type { CommandSpec } from "../../core/registry.js";
import {
  CLOSE_REASONS,
  REQUEST_ROUTES,
  requestArgument,
  triageRequest,
} from "../../core/requests.js";

/**
 * `pidgen request close <request> --reason <reason> [--note <text>] [--duplicate-of <request>]`:
 * closes a Request (`POST /requests/{request_id}/close`) with the version just read. `--reason` is
 * required, one of `cannot_reproduce`, `wont_do`, `duplicate`, `invalid`, `answered`,
 * `no_response`, `withdrawn` and `other`; `duplicate` needs `--duplicate-of` and `other` needs
 * `--note`, checked before anything is sent (`CLI_USAGE`, exit 2). `data` is the Request in its new
 * state.
 */
export const requestClose: CommandSpec = {
  path: ["request", "close"],
  summary: "Close a Request with a reason",
  configure(command: Command) {
    requestArgument(command)
      .addOption(
        new Option(
          "--reason <reason>",
          "why: duplicate needs --duplicate-of and other needs --note",
        ).choices(CLOSE_REASONS),
      )
      .option("--note <text>", "a note on the closing; required for other")
      .option(
        "--duplicate-of <request>",
        "the Request this one duplicates; required for duplicate",
      );
  },
  async run(ctx, { args, options, global }) {
    const reason = requiredText(options, "reason");
    const note = optionalText(options, "note");
    const duplicateOf = optionalText({ "duplicate-of": options["duplicateOf"] }, "duplicate-of");
    if (reason === "duplicate" && duplicateOf === undefined) {
      throw usageError("--reason duplicate needs --duplicate-of <request>.", {
        option: "--duplicate-of",
      });
    }
    if (reason === "other" && note === undefined) {
      throw usageError("--reason other needs --note <text>.", { option: "--note" });
    }
    const body: Record<string, unknown> = { reason };
    if (note !== undefined) body["note"] = note;
    if (duplicateOf !== undefined) body["duplicate_of"] = duplicateOf;
    return triageRequest(ctx, global, args, REQUEST_ROUTES.close, body);
  },
};
