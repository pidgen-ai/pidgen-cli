import type { Command } from "commander";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { presentIntent } from "../../core/requests.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type IntakeRequest = components["schemas"]["IntakeRequest"];
type WithdrawBody = components["schemas"]["WithdrawRequest"];

/**
 * `pidgen intent withdraw <conversation> [--reason <text>]`: withdraws an intake request that is
 * still waiting on answers (`POST /intents/{conversation_id}/withdraw`), with the reason when
 * given. `data` is the withdrawn request, named by its key (`REQ-{n}`), with `state` `withdrawn` and `withdrawn` saying who and
 * when. Two server refusals are refusals, not failures of the call (exit code 5):
 * `REQUEST_WITHDRAW_FORBIDDEN` (the caller may not withdraw it) and `REQUEST_ALREADY_CREATED` (it
 * already became a ticket: `error.details` carries its `ticket_id` and `ticket_key`). An unknown or
 * another Account's request is `CONVERSATION_NOT_FOUND` (exit code 4). An empty `--reason`, or a
 * missing conversation, is a usage error (exit code 2) and sends nothing. The route needs a server
 * that publishes durable requests; a server without it answers 404 (exit code 4). See
 * docs/commands.md, "intent".
 */
export const intentWithdraw: CommandSpec = {
  path: ["intent", "withdraw"],
  summary: "Withdraw an intake request that is still waiting on answers",
  configure(command: Command) {
    command
      .argument("<conversation>", "the request: its key, e.g. REQ-12")
      .option("--reason <text>", "why the request is withdrawn");
  },
  async run(ctx, { args, options, global }) {
    const conversation = pathSegment("conversation", args[0]);
    const reason = options["reason"];
    if (reason !== undefined && String(reason).trim() === "") {
      throw usageError("--reason needs text.", { option: "--reason" });
    }
    const body: WithdrawBody = reason === undefined ? {} : { reason: String(reason) };
    const session = await openSession(ctx, global);
    const response = await session.client.request<IntakeRequest>({
      method: "POST",
      path: `/intents/${conversation}/withdraw`,
      body,
    });
    return { data: presentIntent(response.data), meta: session.meta(response) };
  },
};
