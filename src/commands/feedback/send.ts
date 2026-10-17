import { Option, type Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { readTextInput, validateBody } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import { CLI_VERSION } from "../../core/version.js";
import type { components } from "../../generated/api.js";

type FeedbackSendRequest = components["schemas"]["FeedbackSubmission"];
type FeedbackContextCli = components["schemas"]["FeedbackCliContext"];
type FeedbackReport = components["schemas"]["FeedbackReportResponse"]["data"];
type FeedbackKind = FeedbackSendRequest["kind"];

/** The operation `pidgen feedback` sends, as the public API document names it. */
export const FEEDBACK_ROUTE = { method: "post", path: "/feedback" } as const;

/** `--kind` as typed on the command line, and the API kind each one is sent as. */
export const FEEDBACK_KINDS: Readonly<Record<string, FeedbackKind>> = {
  "not-working": "not_working",
  improvement: "improvement",
  other: "other",
};

/**
 * Server codes that refuse the feedback rather than report a bad request or a server fault; they
 * exit 5 whatever the status (`FEEDBACK_RATE_LIMITED` is a 429, `FEEDBACK_MESSAGE_TOO_LONG` a 422).
 */
export const FEEDBACK_REFUSALS: ReadonlySet<string> = new Set([
  "FEEDBACK_RATE_LIMITED",
  "FEEDBACK_MESSAGE_TOO_LONG",
]);

/**
 * `pidgen feedback --kind not-working|improvement|other <message>`: sends product feedback about
 * Pidgen itself (`POST /feedback`). The message is the argument, or is read from `--message-file
 * <file>` (`-` reads standard input; trailing line breaks are dropped). `--no-contact` sends
 * `contact_ok: false`. The context names where it came from: `source: cli`, the CLI, OS, processor
 * and Node versions and the server (`api_base`), plus `last_command` and `exit_code` when `--after
 * <command> <exit>` is given. The body is validated against `FeedbackSubmission` in the public API
 * document before anything is sent; `INPUT_INVALID` (exit code 2) sends nothing. `data` is the
 * server's report: `id`, `reference` (8 hex characters to quote), `kind` and `created_at`. A
 * refusal keeps its code and exits 5: `FEEDBACK_RATE_LIMITED` and `FEEDBACK_MESSAGE_TOO_LONG`.
 */
export const feedbackSend: CommandSpec = {
  path: ["feedback"],
  summary: "Send product feedback about Pidgen",
  configure(command: Command) {
    const after = new Option(
      "--after <command> <exit>",
      "the pidgen command the feedback is about and its exit code; sent as last_command and exit_code",
    );
    // Two values: commander takes them as a variadic list, and any value after them is the message.
    after.variadic = true;
    command
      .argument("[message]", "the feedback; or give --message-file")
      .addOption(
        new Option("--kind <kind>", "what the feedback is")
          .choices(Object.keys(FEEDBACK_KINDS))
          .makeOptionMandatory(),
      )
      .option("--message-file <file>", "read the message from a file; - reads standard input")
      .option("--no-contact", "do not let Pidgen contact you about this feedback")
      .addOption(after);
  },
  async run(ctx, { args, options, global }) {
    const kind = FEEDBACK_KINDS[String(options["kind"])];
    if (kind === undefined) throw usageError(`Unknown --kind ${String(options["kind"])}.`);
    const after = afterOption(options["after"]);
    const message = await readMessage(ctx, [...args, ...(after?.rest ?? [])], options);

    const session = await openSession(ctx, global);
    const context: FeedbackContextCli = {
      source: "cli",
      cli_version: CLI_VERSION,
      os: process.platform,
      arch: process.arch,
      node_version: process.versions.node,
      api_base: session.target.url,
      ...(after ? { last_command: after.command, exit_code: after.exitCode } : {}),
    };
    const request: FeedbackSendRequest = {
      kind,
      message,
      contact_ok: options["contact"] !== false,
      context,
    };
    const body = validateBody(
      PUBLIC_API_DOCUMENT,
      FEEDBACK_ROUTE.method,
      FEEDBACK_ROUTE.path,
      request,
    );
    try {
      const response = await session.client.request<FeedbackReport>({
        method: "POST",
        path: FEEDBACK_ROUTE.path,
        body,
      });
      return { data: response.data, meta: session.meta(response) };
    } catch (error) {
      if (error instanceof CliError && FEEDBACK_REFUSALS.has(error.code)) {
        throw new CliError(error.code, error.message, ExitCode.Refused, error.details);
      }
      throw error;
    }
  },
};

interface After {
  command: string;
  exitCode: number;
  /** Values given after the two: the message, when it follows `--after`. */
  rest: string[];
}

/** `--after <command> <exit>`: a usage error unless both are given and the exit is an integer. */
function afterOption(value: unknown): After | undefined {
  if (value === undefined) return undefined;
  const values = (Array.isArray(value) ? value : [value]).map(String);
  const [command, exit, ...rest] = values;
  if (command === undefined || exit === undefined) {
    throw usageError("--after needs a command and its exit code: --after <command> <exit>.", {
      option: "--after",
    });
  }
  if (command.trim() === "") {
    throw usageError("--after needs a command.", { option: "--after" });
  }
  if (!/^-?\d+$/.test(exit.trim())) {
    throw usageError(`--after needs an integer exit code, not "${exit}".`, { option: "--after" });
  }
  return { command, exitCode: Number(exit.trim()), rest };
}

/** The message: the one argument, or the text of `--message-file`, never both. */
async function readMessage(
  ctx: Parameters<CommandSpec["run"]>[0],
  args: string[],
  options: Record<string, unknown>,
): Promise<string> {
  if (args.length > 1) {
    throw usageError(
      `too many arguments for 'feedback'. Expected 1 message but got ${args.length}.`,
    );
  }
  const file = options["messageFile"];
  if (file !== undefined) {
    if (args.length > 0) {
      throw usageError("Give the message as an argument or with --message-file, not both.", {
        option: "--message-file",
      });
    }
    const text = await readTextInput(ctx, String(file));
    return text.replace(/(\r?\n)+$/, "");
  }
  const message = args[0];
  if (message === undefined) {
    throw usageError("Give the feedback message as an argument or with --message-file.");
  }
  return message;
}
