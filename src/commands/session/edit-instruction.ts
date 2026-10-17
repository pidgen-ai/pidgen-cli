import type { Command } from "commander";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { addInstructionTextOptions, instructionText } from "../../core/instructions.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type Instruction = components["schemas"]["Instruction"];
type EditBody = components["schemas"]["EditInstructionRequest"];

/**
 * `pidgen session edit-instruction <session> <instruction> (--text <text> | -f <file>)`: changes the
 * text of an instruction that has not been delivered
 * (`PATCH /sessions/{session_id}/instructions/{instruction_id}`). The CLI first reads the
 * session's instructions (`GET /sessions/{session_id}/instructions`) and sends the named
 * instruction's current `version` with the new text, so the change is made to the instruction the
 * person saw. An instruction the session does not list is `INSTRUCTION_NOT_FOUND` (exit code 4)
 * and nothing is changed. `data` is the edited instruction. The server decides whether it can
 * still be edited, whatever the list showed: `INSTRUCTION_ALREADY_DELIVERED` (it was delivered to
 * a prompt) and `INSTRUCTION_VERSION_STALE` (it changed since the read) are refusals (exit code
 * 5), and `INSTRUCTION_NOT_AUTHOR` is a 403 (exit code 3). The text is `--text` or a file, as for
 * `pidgen session steer`. The routes need a server that publishes steering instructions; a server
 * without them answers 404 (exit code 4). See docs/commands.md, "session".
 */
export const sessionEditInstruction: CommandSpec = {
  path: ["session", "edit-instruction"],
  summary: "Change the text of an instruction that has not been delivered",
  configure(command: Command) {
    command
      .argument("<session>", "the agent session's id")
      .argument("<instruction>", "the instruction's id, from pidgen session instructions");
    addInstructionTextOptions(command);
  },
  async run(ctx, { args, options, global }) {
    const sessionId = pathSegment("session", args[0]);
    const instructionId = pathSegment("instruction", args[1]);
    const text = await instructionText(ctx, options);

    const session = await openSession(ctx, global);
    const listed = await session.client.request<Instruction[]>({
      method: "GET",
      path: `/sessions/${sessionId}/instructions`,
    });
    const wanted = decodeURIComponent(instructionId);
    const current = (Array.isArray(listed.data) ? listed.data : []).find(
      (instruction) => instruction.instruction_id === wanted,
    );
    if (current === undefined) {
      throw new CliError(
        "INSTRUCTION_NOT_FOUND",
        `Session ${decodeURIComponent(sessionId)} has no instruction ${wanted}.`,
        ExitCode.NotFound,
        {
          session: decodeURIComponent(sessionId),
          instruction: wanted,
          request_id: listed.requestId,
        },
      );
    }

    const body: EditBody = { text, version: current.version };
    const response = await session.client.request<Instruction>({
      method: "PATCH",
      path: `/sessions/${sessionId}/instructions/${instructionId}`,
      body,
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
