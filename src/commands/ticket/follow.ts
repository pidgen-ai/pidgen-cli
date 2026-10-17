import type { Command } from "commander";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

/** Both following commands send one idempotent PUT and report the server's effective state. */
export function followingCommand(following: boolean): CommandSpec {
  return {
    path: ["ticket", following ? "follow" : "unfollow"],
    summary: following ? "Explicitly follow a ticket" : "Stop explicitly following a ticket",
    configure(command: Command) {
      command.argument("<ref>", "the ticket's key or id");
    },
    async run(ctx, { args, global }) {
      const ref = pathSegment("ticket ref", args[0]);
      const session = await openSession(ctx, global);
      const response = await session.client.request<components["schemas"]["FollowingState"]>({
        method: "PUT",
        path: `/tickets/${ref}/following`,
        body: { following },
      });
      return { data: response.data, meta: session.meta(response) };
    },
  };
}

export const ticketFollow = followingCommand(true);
