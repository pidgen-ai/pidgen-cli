import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { presentIntent } from "../../core/requests.js";
import type { components } from "../../generated/api.js";

type IntakeRequest = components["schemas"]["IntakeRequest"];

/**
 * `pidgen intent show <conversation>`: one intake request (`GET /intents/{conversation_id}`) — its
 * `state`, its structured `questions` and how each was settled, who it waits on (`addressed_to`),
 * the `actions` on offer, and, once it became a ticket, the `ticket_id` and `ticket_key`. The
 * argument is the request's key (`REQ-{n}`) or its id, sent as given. `data` is the server's
 * request, named by its key in `request_id`, by its id only when it has none. An unknown or another Account's request is the server's
 * `CONVERSATION_NOT_FOUND` (exit code 4). The route needs a server that publishes durable
 * requests; a server without it answers 404 (exit code 4). See docs/commands.md, "intent".
 */
export const intentShow: CommandSpec = {
  path: ["intent", "show"],
  summary: "Show one intake request, its questions and what it waits on",
  configure(command: Command) {
    command.argument("<conversation>", "the request: its key, e.g. REQ-12");
  },
  async run(ctx, { args, global }) {
    const conversation = pathSegment("conversation", args[0]);
    const result = await readRoute<IntakeRequest>(ctx, global, `/intents/${conversation}`);
    return { ...result, data: presentIntent(result.data) };
  },
};
