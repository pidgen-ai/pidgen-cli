import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type Instruction = components["schemas"]["Instruction"];

/**
 * `pidgen session instructions <session>`: the instructions steered to one agent session
 * (`GET /sessions/{session_id}/instructions`), newest first, in every state — `queued`,
 * `dispatched`, `accepted`, `delivered`, `acknowledged`, `unapplied` and `withdrawn` (live
 * delivery adds `dispatched` and `accepted`). `data` is the server's array unchanged;
 * each instruction says whether it is still `editable` and its `version`. `acknowledged` means the
 * agent received the instruction, not that it was implemented. An unknown session is
 * `SESSION_NOT_FOUND` (exit code 4). The route needs a server that publishes steering
 * instructions; a server without it answers 404 (exit code 4). See docs/commands.md, "session".
 */
export const sessionInstructions: CommandSpec = {
  path: ["session", "instructions"],
  summary: "List the instructions steered to an agent session",
  configure(command: Command) {
    command.argument("<session>", "the agent session's id");
  },
  async run(ctx, { args, global }) {
    const sessionId = pathSegment("session", args[0]);
    return readRoute<Instruction[]>(ctx, global, `/sessions/${sessionId}/instructions`);
  },
};
