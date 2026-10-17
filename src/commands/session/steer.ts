import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  addComposerOptions,
  addInstructionTextOptions,
  composition,
  instructionText,
  LIVE_DELIVERY_HELP,
  QUOTE_FILE_FORM,
} from "../../core/instructions.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type Instruction = components["schemas"]["Instruction"];
/** The request, with `mode` left out unless `--queue` asks for `queue` (the server's default is `steer`). */
type SteerBody = Omit<components["schemas"]["SteerRequest"], "mode"> & {
  mode?: components["schemas"]["SteerRequest"]["mode"];
};

/**
 * `pidgen session steer <session> (--text <text> | -f <file>) [--queue] [--attach <artifact>]...
 * [--quote-message <id>]... [--quote-file <PATH:START-END@SNAPSHOT>]...`: gives
 * one agent session an instruction (`POST /sessions/{session_id}/instructions`). The server queues
 * it, then delivers it live or at the next attempt. Live: while the step's attempt is
 * running on a worker that supports it, the instruction is `dispatched` to that running session and
 * `accepted` into the agent's conversation, and `acknowledged` when the attempt settles. Next
 * attempt: otherwise, or when the running session refuses it (it returns to `queued` with a
 * `return_code`), it is `delivered` once to the step's next prompt, then acknowledged, or reported
 * unapplied when the step never runs again. It can be edited or withdrawn only while it is queued.
 * `data` is the server's instruction unchanged, in whatever state the server reports, with its
 * `mode`. The text is `--text` or a file (`-f -` reads standard input), exactly one of them,
 * 1-8000 characters; giving both or neither, empty text or over-long text is a usage error (exit
 * code 2) and sends nothing.
 *
 * The composer's flags: `--queue` sends `mode: queue` (without it the request leaves
 * the mode to the server's default, `steer`); `--attach` pins existing artifacts
 * (`artifact_refs`); `--quote-message` records conversation messages
 * the text quotes (`source_message_ids`); `--quote-file` records file lines it quotes from a
 * snapshot commit (`quoted_file_refs`, with the digest of those lines in the local file). Every
 * flag is checked and every file read before anything is sent; at most ten attachments in all.
 * The quotes are provenance only: the text is the instruction. Staging a local file to pin
 * (`--upload`, the request's `upload_ids`) is planned: the public API does not yet publish an
 * upload route.
 *
 * The command sends one generated `idempotency_key`, and the HTTP client retries a lost response
 * with the same body, so a retried request does not queue the instruction twice. The server's refusals keep their codes: `STEP_SETTLED`, `RUN_PAUSED`, `RUN_HELD`,
 * `RUN_TERMINAL` and `STEER_TARGET_NOT_PROMPT` (409) are refusals (exit code 5), an unknown
 * session is `SESSION_NOT_FOUND` (exit code 4), `STEER_EMPTY`, `STEER_TOO_LONG`,
 * `ARTIFACT_REFERENCE_UNAVAILABLE` and `MODE_UNSUPPORTED` (422) exit 2, and a 403 exits 3. See
 * docs/commands.md, "session".
 */
export const sessionSteer: CommandSpec = {
  path: ["session", "steer"],
  summary: "Steer an agent session: deliver an instruction live, or to its next attempt",
  configure(command: Command) {
    command.argument("<session>", "the agent session's id");
    addInstructionTextOptions(command);
    addComposerOptions(command);
    command.addHelpText(
      "after",
      [
        "",
        "While the step's attempt is running on a worker that supports live delivery,",
        "the instruction goes to that running session; otherwise it goes to the step's",
        "next attempt. This command sends the default mode, steer, unless --queue asks",
        "for queue, and prints the instruction in the state the server reports, with",
        "its mode.",
        "",
        "--attach pins an existing artifact by id, at most 10 in all.",
        "--quote-message and --quote-file record what the text quotes, as provenance:",
        "the text is the instruction, so put the quoted words in it yourself.",
        `--quote-file takes ${QUOTE_FILE_FORM}: lines START to END of PATH in the`,
        "snapshot commit SNAPSHOT. PATH is read from the working directory to digest",
        "the quoted lines, so check out that snapshot first.",
        LIVE_DELIVERY_HELP,
      ].join("\n"),
    );
  },
  async run(ctx, { args, options, global }) {
    const sessionId = pathSegment("session", args[0]);
    const text = await instructionText(ctx, options);
    const composed = await composition(ctx, options);
    const session = await openSession(ctx, global);
    const body: SteerBody = {
      text,
      ...(composed.mode !== undefined ? { mode: composed.mode } : {}),
      ...(composed.artifactIds.length > 0
        ? { artifact_refs: composed.artifactIds.map((artifact_id) => ({ artifact_id })) }
        : {}),
      ...(composed.sourceMessageIds.length > 0
        ? { source_message_ids: composed.sourceMessageIds }
        : {}),
      ...(composed.quotedFileRefs.length > 0 ? { quoted_file_refs: composed.quotedFileRefs } : {}),
      idempotency_key: randomUUID(),
    };
    const response = await session.client.request<Instruction>({
      method: "POST",
      path: `/sessions/${sessionId}/instructions`,
      body,
      idempotent: true,
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
