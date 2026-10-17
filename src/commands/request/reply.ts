import type { Command } from "commander";
import { requiredText } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";
import { REQUEST_ROUTES, requestArgument, triageRequest } from "../../core/requests.js";

/**
 * `pidgen request reply <request> --text <text> [--ask]`: replies to the requester
 * (`POST /requests/{request_id}/reply`), or with `--ask` asks them a question, after which the
 * Request waits on them (`POST /requests/{request_id}/ask`). Either sends the version just read.
 * `data` is the Request in its new state; a reply also names the timeline entry it wrote
 * (`{state, request, entry_id}`).
 */
export const requestReply: CommandSpec = {
  path: ["request", "reply"],
  summary: "Reply to a Request's requester, or ask them a question",
  configure(command: Command) {
    requestArgument(command)
      .option("--text <text>", "the reply or the question")
      .option("--ask", "ask a question; the Request then waits on the requester");
  },
  async run(ctx, { args, options, global }) {
    const text = requiredText(options, "text");
    const route = options["ask"] === true ? REQUEST_ROUTES.ask : REQUEST_ROUTES.reply;
    return triageRequest(ctx, global, args, route, { text });
  },
};
