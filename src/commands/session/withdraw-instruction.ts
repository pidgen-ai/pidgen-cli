import type { Command } from "commander";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type Instruction = components["schemas"]["Instruction"];

/**
 * `pidgen session withdraw-instruction <session> <instruction>`: withdraws an instruction that has
 * not been delivered (`POST /sessions/{session_id}/instructions/{instruction_id}/withdraw`, no
 * body). `data` is the withdrawn instruction, with `state` `withdrawn`. The server decides whether
 * it can still be withdrawn: `INSTRUCTION_ALREADY_DELIVERED` is a refusal (exit code 5), and
 * `INSTRUCTION_NOT_AUTHOR` is a 403 (exit code 3). An unknown session or instruction is the
 * server's 404 (exit code 4). Withdrawing is not retried after a lost response, since a second
 * attempt would be answered as a refusal. The route needs a server that publishes steering
 * instructions; a server without it answers 404 (exit code 4). See docs/commands.md, "session".
 */
export const sessionWithdrawInstruction: CommandSpec = {
  path: ["session", "withdraw-instruction"],
  summary: "Withdraw an instruction that has not been delivered",
  configure(command: Command) {
    command
      .argument("<session>", "the agent session's id")
      .argument("<instruction>", "the instruction's id, from pidgen session instructions");
  },
  async run(ctx, { args, global }) {
    const sessionId = pathSegment("session", args[0]);
    const instructionId = pathSegment("instruction", args[1]);
    const session = await openSession(ctx, global);
    const response = await session.client.request<Instruction>({
      method: "POST",
      path: `/sessions/${sessionId}/instructions/${instructionId}/withdraw`,
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
