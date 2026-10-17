import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { RunContext } from "./context.js";
import { usageError } from "./errors.js";
import { inputInvalid, readTextInput } from "./input.js";
import type { components } from "../generated/api.js";

type Instruction = components["schemas"]["Instruction"];
type QuotedFileRef = components["schemas"]["QuotedFileReference"];

/** The kinds `pidgen ticket instructions --kind` accepts: the contract's `Instruction.kind`. */
export const INSTRUCTION_KINDS = [
  "steer",
  "request_changes",
] as const satisfies readonly Instruction["kind"][];

/**
 * Every state of an instruction (`Instruction.state`), in the order an instruction
 * moves through them. `dispatched` and `accepted` are the live path: claimed for the step's running
 * session and sent to its worker, then added to the agent's running conversation. `delivered` is
 * the next-attempt path. The state `queued` (not yet handed to anything) is not the mode `queue`.
 */
export const INSTRUCTION_STATES = [
  "queued",
  "dispatched",
  "accepted",
  "delivered",
  "acknowledged",
  "unapplied",
  "withdrawn",
] as const satisfies readonly Instruction["state"][];

/**
 * The modes an instruction has in this release (`Instruction.mode`): `steer` reaches
 * the agent at the provider's next safe point, `queue` when it would otherwise finish. `interrupt`
 * is reserved and published by neither the contract nor the CLI.
 */
export const INSTRUCTION_MODES = [
  "steer",
  "queue",
] as const satisfies readonly Instruction["mode"][];

/**
 * How an instruction reaches the agent, live or at the next attempt, for the help of the commands
 * that print instructions (`pidgen session steer`, `pidgen ticket instructions`). Plain text: help is
 * not Markdown.
 */
export const LIVE_DELIVERY_HELP = [
  "",
  "How an instruction reaches the agent (each instruction's state):",
  "  queued        not yet given to the agent; it can be edited or withdrawn",
  "  dispatched    live: sent to the step's running session",
  "  accepted      live: in the agent's running conversation (consumed_at: read)",
  "  delivered     next attempt: carried by the step's next prompt",
  "  acknowledged  the attempt it reached settled: received, not proof of the work",
  "  unapplied     the step never ran again",
  "  withdrawn     withdrawn by its author while queued",
  "",
  "When the running session cannot take a dispatched instruction, it returns to",
  "queued with a return_code saying why (for example HARNESS_UNSUPPORTED or",
  "ATTEMPT_SETTLING) and goes to the step's next attempt instead: the running",
  "session did not receive it.",
  "",
  "Each instruction has a mode: steer reaches the agent at its next safe point,",
  "after the current tool calls; queue reaches it when it would otherwise finish.",
  "",
].join("\n");

/** The most characters an instruction's text may have (`SteerSessionRequest.text`'s `maxLength`). */
export const INSTRUCTION_TEXT_MAX_LENGTH = 8000;

/** Adds the two ways to give an instruction's text: `--text <text>` or `-f <file>`. */
export function addInstructionTextOptions(command: Command): Command {
  return command
    .option("--text <text>", "the instruction's text (1-8000 characters); or use -f")
    .option("-f, --file <file>", "read the instruction's text from a file; - reads standard input");
}

/**
 * The instruction's text from `--text` or `-f <file>` (`-f -` reads standard input), with its
 * surrounding whitespace removed. Giving both or neither, text that is empty, or text longer than
 * the server accepts is a usage error (exit code 2) and nothing is sent; an unreadable file is
 * `INPUT_INVALID` (exit code 2) too.
 */
export async function instructionText(
  ctx: RunContext,
  options: Record<string, unknown>,
): Promise<string> {
  const text = options["text"];
  const file = options["file"];
  if (text !== undefined && file !== undefined) {
    throw usageError("--text and -f are mutually exclusive: give the instruction one way.", {
      options: ["--text", "-f"],
    });
  }
  if (text === undefined && file === undefined) {
    throw usageError("Give the instruction with --text <text> or -f <file>.", {
      options: ["--text", "-f"],
    });
  }
  const raw = text !== undefined ? String(text) : await readTextInput(ctx, String(file));
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw usageError("The instruction is empty.", { option: text !== undefined ? "--text" : "-f" });
  }
  // The server counts characters, not UTF-16 code units.
  const length = [...trimmed].length;
  if (length > INSTRUCTION_TEXT_MAX_LENGTH) {
    throw usageError(
      `The instruction is ${length} characters; the most it can be is ${INSTRUCTION_TEXT_MAX_LENGTH}.`,
      { max_length: INSTRUCTION_TEXT_MAX_LENGTH, length },
    );
  }
  return trimmed;
}

/**
 * The most artifacts one instruction may pin with `--attach` (the server's limit of ten pinned
 * artifacts per instruction).
 */
export const INSTRUCTION_ATTACHMENTS_MAX = 10;

/** The form `--quote-file` takes, as the help and the usage errors name it. */
export const QUOTE_FILE_FORM = "PATH:START-END@SNAPSHOT";

/**
 * The composer's choices for one instruction, checked and read before anything is sent: the mode
 * (`--queue`), the artifacts to pin (`--attach`) and what the author quoted (`--quote-message`,
 * `--quote-file`). Staging a local file to pin (`--upload`) is planned: it needs the server to
 * publish an upload route, which the public API does not yet have (docs/api-compatibility.md).
 */
export interface Composition {
  mode: "queue" | undefined;
  artifactIds: string[];
  sourceMessageIds: string[];
  quotedFileRefs: QuotedFileRef[];
}

function appendValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Adds the composer's flags to `pidgen session steer`. */
export function addComposerOptions(command: Command): Command {
  return command
    .option(
      "--queue",
      "queue mode: reach the agent when it would otherwise finish (default: steer)",
    )
    .option(
      "--attach <artifact>",
      "pin an existing artifact to the instruction, by id; repeatable",
      appendValue,
      [],
    )
    .option(
      "--quote-message <id>",
      "a conversation message the text quotes (provenance); repeatable",
      appendValue,
      [],
    )
    .option(
      `--quote-file <${QUOTE_FILE_FORM}>`,
      "file lines the text quotes, from a snapshot commit (provenance); repeatable",
      appendValue,
      [],
    );
}

function values(options: Record<string, unknown>, name: string): string[] {
  const given = options[name];
  return Array.isArray(given) ? given.map(String) : [];
}

function identifiers(options: Record<string, unknown>, name: string, flag: string, what: string) {
  return values(options, name).map((value) => {
    const trimmed = value.trim();
    if (trimmed === "") throw usageError(`${flag} needs ${what}.`, { option: flag });
    return trimmed;
  });
}

/**
 * Reads and checks the composer's flags. An empty `--attach` or `--quote-message`, more than
 * {@link INSTRUCTION_ATTACHMENTS_MAX} attachments, or a `--quote-file` that is malformed or does
 * not fit its local file is a usage error (exit code 2) and nothing is sent.
 */
export async function composition(
  ctx: RunContext,
  options: Record<string, unknown>,
): Promise<Composition> {
  const artifactIds = identifiers(options, "attach", "--attach", "an artifact id");
  const sourceMessageIds = identifiers(options, "quoteMessage", "--quote-message", "a message id");
  const attachments = artifactIds.length;
  if (attachments > INSTRUCTION_ATTACHMENTS_MAX) {
    throw usageError(
      `An instruction pins at most ${INSTRUCTION_ATTACHMENTS_MAX} artifacts (--attach); ${attachments} were given.`,
      { max_attachments: INSTRUCTION_ATTACHMENTS_MAX, attachments },
    );
  }
  const quotedFileRefs = [];
  for (const quote of values(options, "quoteFile")) {
    quotedFileRefs.push(await quoteFile(ctx, quote));
  }
  return {
    mode: options["queue"] === true ? "queue" : undefined,
    artifactIds,
    sourceMessageIds,
    quotedFileRefs,
  };
}

async function readBytes(ctx: RunContext, source: string, what: string): Promise<Uint8Array> {
  try {
    return await readFile(resolve(ctx.cwd, source));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    throw inputInvalid(`Cannot read ${what} file ${source}: ${reason}`, { source });
  }
}

const QUOTE_FILE = /^(.+):(\d+)-(\d+)@([^@]*)$/;
const COMMIT = /^[0-9a-f]{7,64}$/i;

/**
 * One `--quote-file PATH:START-END@SNAPSHOT`: the lines START to END of PATH as the snapshot
 * commit SNAPSHOT has them, quoted from the change's new side. The digest is the `sha256:` of
 * those lines (joined with `\n`, without a final newline) as the local file at PATH has them, so
 * PATH is read relative to the working directory, which should hold that snapshot.
 */
export async function quoteFile(ctx: RunContext, quote: string): Promise<QuotedFileRef> {
  const match = QUOTE_FILE.exec(quote);
  if (match === null) {
    throw usageError(
      `--quote-file takes ${QUOTE_FILE_FORM}, e.g. src/app.ts:10-12@7a3c91e; got ${quote}.`,
      {
        option: "--quote-file",
        value: quote,
      },
    );
  }
  const [, path, first, last, snapshot] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const start = Number(first);
  const end = Number(last);
  if (start < 1) {
    throw usageError(`--quote-file ${quote}: lines are counted from line 1.`, {
      option: "--quote-file",
      value: quote,
    });
  }
  if (end < start) {
    throw usageError(
      `--quote-file ${quote}: the quote ends at line ${end}, before it starts at line ${start}.`,
      {
        option: "--quote-file",
        value: quote,
      },
    );
  }
  if (!COMMIT.test(snapshot)) {
    throw usageError(
      `--quote-file ${quote}: the snapshot ${snapshot || "(none)"} is not a commit; give the snapshot's commit SHA.`,
      { option: "--quote-file", value: quote },
    );
  }
  const text = new TextDecoder().decode(await readBytes(ctx, path, "quoted"));
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (end > lines.length) {
    throw usageError(
      `--quote-file ${quote}: ${path} has ${lines.length} lines; the quote ends at line ${end}.`,
      { option: "--quote-file", value: quote, lines: lines.length },
    );
  }
  const span = lines.slice(start - 1, end).join("\n");
  return {
    path,
    side: "new",
    start_line: start,
    end_line: end,
    source: "snapshot",
    snapshot_commit_sha: snapshot,
    digest: `sha256:${createHash("sha256").update(span, "utf8").digest("hex")}`,
  };
}
