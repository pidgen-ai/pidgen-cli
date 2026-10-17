import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { usageError } from "../../core/errors.js";
import { readInput, validateBody } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type SubmittedIntent =
  components["schemas"]["IntentCreated"] | components["schemas"]["IntentClarification"];

/** The operation `intent submit` sends, as the public API document names it. */
export const SUBMIT_ROUTE = { method: "post", path: "/intents" } as const;

/** The longest `--submission-key` the server accepts (`submission_key`'s `maxLength`). */
export const SUBMISSION_KEY_MAX_LENGTH = 200;

/**
 * `pidgen intent submit -f <file> [--submission-key <key>]`: submits prose work (`POST /intents`)
 * from a JSON or YAML file, or standard input with `-f -`. The body is validated against
 * `SubmitIntentRequest` in the public API document before anything is sent and is sent as
 * written; a body that does not parse or match is `INPUT_INVALID` (exit code 2). `data` is the
 * server's result, switched on `outcome`: `created` carries the new ticket (`ticket_id`,
 * `ticket_key`, `stage`, ...), and `needs_clarification` carries the `conversation_id` and its
 * `questions` to answer with `pidgen intent respond`, and, from a server that publishes durable
 * requests, the `request_id` and the `request` itself. `--submission-key` is sent as
 * `submission_key`: submitting again with the same key and body returns the same outcome, and the
 * same key with another body is the server's `SUBMISSION_KEY_REUSED` (a refusal, exit code 5). A
 * body file that already has a `submission_key` keeps it unless the option is given. An empty key,
 * or one longer than the server accepts, is a usage error (exit code 2) and sends nothing. A
 * server refusal keeps its code, e.g. `PROJECT_NOT_FOUND` (exit code 4) or `PROJECT_REQUIRED`
 * (exit code 2). The key and the durable request need a server that publishes them; see
 * docs/commands.md, "intent".
 */
export const intentSubmit: CommandSpec = {
  path: ["intent", "submit"],
  summary: "Submit prose work; returns a ticket or clarification questions",
  configure(command: Command) {
    command
      .requiredOption(
        "-f, --file <file>",
        "the intent as JSON or YAML (title, objective, project_id, ...); - reads standard input",
      )
      .option(
        "--submission-key <key>",
        "a key you choose for this submission: submitting it again returns the same outcome",
      );
  },
  async run(ctx, { options, global }) {
    const input = await readInput(ctx, String(options["file"]));
    const key = submissionKey(options["submissionKey"]);
    const value =
      key !== undefined && isRecord(input.value)
        ? { ...input.value, submission_key: key }
        : input.value;
    const body = validateBody(PUBLIC_API_DOCUMENT, SUBMIT_ROUTE.method, SUBMIT_ROUTE.path, value);
    const session = await openSession(ctx, global);
    const response = await session.client.request<SubmittedIntent>({
      method: "POST",
      path: SUBMIT_ROUTE.path,
      body,
    });
    return { data: response.data, meta: session.meta(response) };
  },
};

/** `--submission-key`, sent as given: a usage error when empty or longer than the server takes. */
function submissionKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const key = String(value);
  if (key.trim() === "") {
    throw usageError("--submission-key needs a value.", { option: "--submission-key" });
  }
  if (key.length > SUBMISSION_KEY_MAX_LENGTH) {
    throw usageError(`--submission-key is longer than ${SUBMISSION_KEY_MAX_LENGTH} characters.`, {
      option: "--submission-key",
      max_length: SUBMISSION_KEY_MAX_LENGTH,
    });
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
