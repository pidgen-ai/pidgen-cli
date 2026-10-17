import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { ticketRef } from "../../core/refs.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";

/**
 * `pidgen plan show <root>`: the current child plan of a high-level ticket — its children, the
 * dependencies between them, its `ticket_version` and `materialized_plan_digest`. Reads
 * `GET /tickets/{ref}/child-plan`. See docs/commands.md, "plan".
 */
export const planShow: CommandSpec = {
  path: ["plan", "show"],
  summary: "Show a ticket's child plan with its version and digest",
  configure(command) {
    command.argument("<root>", "the high-level ticket, e.g. PIDGEN-12");
  },
  async run(ctx, { args, global }) {
    const root = ticketRef(args[0], "<root>");
    const session = await openSession(ctx, global);
    const response = await session.client.request({
      method: "GET",
      path: `/tickets/${encodeURIComponent(root)}/child-plan`,
    });
    const data = response.data;
    if (
      !isRecord(data) ||
      !Number.isInteger(data["ticket_version"]) ||
      !(
        typeof data["materialized_plan_digest"] === "string" ||
        data["materialized_plan_digest"] === null
      )
    ) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        "The server's child plan did not carry its ticket_version and materialized_plan_digest.",
        ExitCode.Unexpected,
        { request_id: response.requestId },
      );
    }
    return { data, meta: session.meta(response) };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
