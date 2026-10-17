import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { inputInvalid, readInput, validateBody } from "../../core/input.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type TicketClarification = components["schemas"]["TicketClarification"];
type ClarificationResult = components["schemas"]["ClarificationResult"];

/** The operation `ticket clarify` sends, as the public API document names it. */
export const CLARIFY_ROUTE = {
  method: "post",
  path: "/tickets/{ticket_id}/clarification",
} as const;

/** The server's code for a ticket with no open clarification. */
const NOT_FOUND_CODE = "CLARIFICATION_NOT_FOUND";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `pidgen ticket clarify <ref> -f <answers>`: answers, or abandons, the clarification a ticket's
 * refine gate is parked on (`POST /tickets/{ref}/clarification`). The file is the request body as
 * JSON or YAML (`-f -` reads standard input): `answers`, each question's `key` to its answer,
 * optionally `outcome` (`answered`, the default, or `abandoned`), `note`, `gate_generation` and
 * `idempotency_key`. `abandoned` is deprecated: it now places a hold on the decision and leaves
 * the question open, and the result's `hold` is that hold (null otherwise). It is validated
 * against `ClarificationAnswerRequest` before anything is sent; an `answered` file with no answer
 * is `INPUT_INVALID` too (exit code 2).
 *
 * The CLI first reads the open clarification (`GET /tickets/{ref}/clarification`). A ticket with
 * no open question — the server's `CLARIFICATION_NOT_FOUND`, from the read or the answer — is a
 * refusal, not a missing ticket: it exits 5 with that code. An open record that addresses an
 * earlier gate generation (`stale`) exits 5 with `INTERVENTION_STALE` and sends nothing. When the
 * file names no `gate_generation`, the CLI sends the one the read reported, so the answers settle
 * the question the person saw. `data` is the server's result.
 */
export const ticketClarify: CommandSpec = {
  path: ["ticket", "clarify"],
  summary: "Answer or abandon the clarification a ticket is parked on",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .requiredOption(
        "-f, --file <answers>",
        "the answers as JSON or YAML ({answers: {key: answer}, outcome, note}); - reads standard input",
      )
      .addHelpText(
        "after",
        [
          "",
          "Outcome:",
          "  answered (the default) writes the answers and resumes the ticket.",
          "  abandoned is deprecated: it now places a hold on the decision and leaves the",
          "  question open. The result's hold is that hold; a server that does not publish",
          "  decision follow-up still closes the clarification.",
          "",
        ].join("\n"),
      );
  },
  async run(ctx, { args, options, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    const input = await readInput(ctx, String(options["file"]));
    const body = clarifyBody(input.value);

    const session = await openSession(ctx, global);
    const open = await refusingNotFound(() =>
      session.client.request<TicketClarification>({
        method: "GET",
        path: `/tickets/${ref}/clarification`,
      }),
    );
    if (open.data?.stale === true) {
      throw new CliError(
        "INTERVENTION_STALE",
        `The open clarification of ${args[0]?.trim()} addresses an earlier gate generation and cannot be answered; read the ticket again.`,
        ExitCode.Refused,
        { request_id: open.requestId, intervention_id: open.data.intervention_id },
      );
    }
    const generation = open.data?.gate_generation;
    const send =
      body["gate_generation"] === undefined && typeof generation === "number"
        ? { ...body, gate_generation: generation }
        : body;

    const response = await refusingNotFound(() =>
      session.client.request<ClarificationResult>({
        method: "POST",
        path: `/tickets/${ref}/clarification`,
        body: send,
      }),
    );
    return { data: response.data, meta: session.meta(response) };
  },
};

/** The file's body, checked against the answer schema; `answered` needs at least one answer. */
function clarifyBody(value: unknown): Record<string, unknown> {
  const body = validateBody(PUBLIC_API_DOCUMENT, CLARIFY_ROUTE.method, CLARIFY_ROUTE.path, value);
  if (!isRecord(body)) throw inputInvalid("The answers file must be an object.");
  const outcome = body["outcome"] ?? "answered";
  const answers = body["answers"];
  if (outcome === "answered" && (!isRecord(answers) || Object.keys(answers).length === 0)) {
    throw inputInvalid("The answers file answers no question.", {
      issues: [{ path: "$.answers", message: "Answer at least one question by its key." }],
    });
  }
  return body;
}

/** A ticket with no open clarification is a refusal (exit code 5), keeping the server's code. */
async function refusingNotFound<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof CliError && error.code === NOT_FOUND_CODE) {
      throw new CliError(error.code, error.message, ExitCode.Refused, error.details);
    }
    throw error;
  }
}
