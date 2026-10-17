import { Option, type Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import {
  DETAIL_FIELDS,
  REQUEST_PRIORITIES,
  REQUEST_ROUTES,
  requestArgument,
  triageRequest,
} from "../../core/requests.js";

/**
 * `pidgen request accept <request> [--priority P1-P4] [--unknown <field>...]`: accepts a Request
 * as work to do (`POST /requests/{request_id}/accept`) with the version just read. A bug is
 * accepted only with its steps, expected and actual results, or with the missing ones named by
 * `--unknown` (`steps`, `expected`, `actual`); otherwise the server refuses with
 * `REQUEST_BUG_DETAILS_REQUIRED`. `data` is the Request in its new state.
 */
export const requestAccept: CommandSpec = {
  path: ["request", "accept"],
  summary: "Accept a Request, with a priority and a bug's unknown details",
  configure(command: Command) {
    requestArgument(command)
      .addOption(new Option("--priority <priority>", "the priority").choices(REQUEST_PRIORITIES))
      .addOption(
        new Option("--unknown <field...>", "a bug's details accepted as unknown").choices(
          DETAIL_FIELDS,
        ),
      );
  },
  async run(ctx, { args, options, global }) {
    const body: Record<string, unknown> = {};
    if (options["priority"] !== undefined) body["priority"] = options["priority"];
    if (options["unknown"] !== undefined) body["unknown"] = options["unknown"];
    return triageRequest(ctx, global, args, REQUEST_ROUTES.accept, body);
  },
};
