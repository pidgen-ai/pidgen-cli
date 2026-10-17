import type { Command } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import {
  presentRequest,
  REQUEST_ROUTES,
  requestArgument,
  requestSegment,
  sendRequestRoute,
  type Request,
  type RequestTimelineEntry,
} from "../../core/requests.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen request show <request>`: one Request (`GET /requests/{request_id}`) and its timeline
 * (`GET /requests/{request_id}/timeline`). `data` is `{request, timeline}`: the Request with its
 * requester, whose `contact` is left out when the server withholds it (a caller without
 * `request.triage`), and the timeline's entries, oldest first, each with its attachments.
 */
export const requestShow: CommandSpec = {
  path: ["request", "show"],
  summary: "Show a Request, its requester and its timeline with attachments",
  configure(command: Command) {
    requestArgument(command);
  },
  async run(ctx, { args, global }) {
    const id = requestSegment(args);
    const session = await openSession(ctx, global);
    const { data: request, response } = await sendRequestRoute<Request>(
      session,
      REQUEST_ROUTES.show,
      { request_id: id },
    );
    const { data: timeline } = await sendRequestRoute<RequestTimelineEntry[]>(
      session,
      REQUEST_ROUTES.timeline,
      { request_id: id },
    );
    return { data: { request: presentRequest(request), timeline }, meta: session.meta(response) };
  },
};
