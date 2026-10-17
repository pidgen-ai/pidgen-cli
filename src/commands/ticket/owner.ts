import type { Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

export const ticketOwner: CommandSpec = {
  path: ["ticket", "owner"],
  summary: "Set or clear a ticket's owner using its current version",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key or id")
      .option("--user <user_id>", "the user to own the ticket")
      .option("--clear", "clear the ticket's explicit owner")
      .option("--reason <text>", "the reason for changing the owner");
  },
  async run(ctx, { args, options, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    const hasUser = options["user"] !== undefined;
    if (hasUser === (options["clear"] === true)) {
      throw usageError("Give exactly one of --user or --clear.");
    }
    const user = hasUser ? String(options["user"]).trim() : null;
    if (user === "") throw usageError("--user needs a user id.", { option: "--user" });

    const session = await openSession(ctx, global);
    const current = await session.client.request<components["schemas"]["TicketDetailResource"]>({
      method: "GET",
      path: `/tickets/${ref}`,
    });
    const version = current.data?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        "The server's ticket has no version to change the owner against.",
        ExitCode.Unexpected,
        { request_id: current.requestId },
      );
    }
    const body: components["schemas"]["ChangeOwnerRequest"] = {
      version,
      owner_user_id: user,
      ...(options["reason"] !== undefined ? { reason: String(options["reason"]) } : {}),
    };
    try {
      const response = await session.client.request<components["schemas"]["OwnerChange"]>({
        method: "PUT",
        path: `/tickets/${ref}/owner`,
        body,
      });
      return { data: response.data, meta: session.meta(response) };
    } catch (error) {
      if (error instanceof CliError && error.code === "OWNER_NOT_ELIGIBLE") {
        throw new CliError(error.code, error.message, ExitCode.Refused, error.details);
      }
      throw error;
    }
  },
};
