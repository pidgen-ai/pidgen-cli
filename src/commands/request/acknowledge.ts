import type { Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import { REQUEST_ROUTES, requestArgument, triageRequest } from "../../core/requests.js";

/**
 * `pidgen request acknowledge <request>`: tells the requester the Request was seen
 * (`POST /requests/{request_id}/acknowledge`), with the version just read. `data` is the Request
 * in its new state.
 */
export const requestAcknowledge: CommandSpec = {
  path: ["request", "acknowledge"],
  summary: "Acknowledge a Request",
  configure(command: Command) {
    requestArgument(command);
  },
  async run(ctx, { args, global }) {
    return triageRequest(ctx, global, args, REQUEST_ROUTES.acknowledge);
  },
};
