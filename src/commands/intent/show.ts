import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type IntakeRequest = components["schemas"]["IntakeRequest"];

/**
 * `pidgen intent show <conversation>`: one intake request (`GET /intents/{conversation_id}`) — its
 * `state`, its structured `questions` and how each was settled, who it waits on (`addressed_to`),
 * the `actions` on offer, and, once it became a ticket, the `ticket_id` and `ticket_key`. `data` is
 * the server's request unchanged. An unknown or another Account's request is the server's
 * `CONVERSATION_NOT_FOUND` (exit code 4). The route needs a server that publishes durable
 * requests; a server without it answers 404 (exit code 4). See docs/commands.md, "intent".
 */
export const intentShow: CommandSpec = {
  path: ["intent", "show"],
  summary: "Show one intake request, its questions and what it waits on",
  configure(command: Command) {
    command.argument(
      "<conversation>",
      "the conversation_id from pidgen intent submit, e.g. conv-…",
    );
  },
  async run(ctx, { args, global }) {
    const conversation = pathSegment("conversation", args[0]);
    return readRoute<IntakeRequest>(ctx, global, `/intents/${conversation}`);
  },
};
