import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Option, type Command } from "commander";
import type { RunContext } from "../../core/context.js";
import { optionalText } from "../../core/domains.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { parseInput, readInput, readTextInput } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";
import {
  isRecord,
  parseTarget,
  presentRequest,
  REQUEST_KINDS,
  REQUEST_ROUTES,
  REQUEST_URGENCIES,
  requestUrl,
  sendRequestRoute,
  validateRequestBody,
  type RequestAttachment,
  type RequestReceived,
} from "../../core/requests.js";
import { openSession } from "../../core/session.js";

/** The media type an evidence file is sent with, by its extension. */
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".har": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

interface Evidence {
  name: string;
  path: string;
  file: Blob;
}

/**
 * `pidgen request submit [-f <file>] [--kind <kind>] [--title <title>] [--body <text>] [--steps
 * <text>] [--expected <text>] [--actual <text>] [--urgency <urgency>] [--target <kind>:<id>]
 * [--fingerprint <text>] [--submission-key <key>] [--evidence <file>...]`: submits a Request
 * (`POST /requests`) through the source the credential is bound to.
 *
 * The body is the stated one: `{kind, title, body, details?, urgency?, target?, external_ref?,
 * external_url?, requester?, fingerprint?, submission_key?}`. `-f` with a `.json`, `.yaml` or
 * `.yml` file (or standard input starting with `{`) gives that body, which the flags override; any
 * other file is the `body` text. `--steps`, `--expected` and `--actual` are a bug's `details`;
 * `--target` is `project:<id>` or `domain:<id>`. Without `--submission-key` one is generated, so a
 * retry after a network failure is the same submission. The body is validated against the published
 * document before anything is sent (`INPUT_INVALID`, exit 2), and each `--evidence` file is read
 * first (a missing one is `CLI_USAGE`, exit 2).
 *
 * `data` is `{outcome, url, request, entry_id, occurrence_id, attachments}`: what the submission
 * did (`created`, `appended`, `occurrence` or `regression`), the Request's page, and each evidence
 * file as uploaded (`POST /requests/{request_id}/attachments`) to the returned `occurrence_id`, or
 * else `entry_id`. A refused upload keeps its code and exit, and its details name the Request filed.
 */
export const requestSubmit: CommandSpec = {
  path: ["request", "submit"],
  summary: "Submit a Request, with a bug's details and evidence files",
  configure(command: Command) {
    command
      .option(
        "-f, --file <file>",
        "the Request as JSON or YAML, or a text file as its body; - reads standard input",
      )
      .addOption(new Option("--kind <kind>", "what is asked for").choices(REQUEST_KINDS))
      .option("--title <title>", "a one-line title")
      .option("--body <text>", "what is asked, in the requester's words")
      .option("--steps <text>", "a bug's steps to reproduce")
      .option("--expected <text>", "what a bug should have done")
      .option("--actual <text>", "what a bug did instead")
      .addOption(new Option("--urgency <urgency>", "how urgent it is").choices(REQUEST_URGENCIES))
      .option("--target <kind:id>", "where it is aimed: project:<id> or domain:<id>")
      .option("--fingerprint <text>", "identifies the same problem across submissions")
      .option("--submission-key <key>", "makes a retry the same submission (default: generated)")
      .option("--evidence <file...>", "files to attach: screenshots, logs");
  },
  async run(ctx, { options, global }) {
    const source = options["file"] as string | undefined;
    if (source !== undefined && options["body"] !== undefined) {
      throw usageError("Give the body with --body or -f, not both.", {
        options: ["--body", "-f"],
      });
    }
    const base = source === undefined ? {} : await readBase(ctx, source);

    const flags: Record<string, unknown> = {};
    for (const name of ["kind", "title", "body", "urgency", "fingerprint"] as const) {
      const value = optionalText(options, name);
      if (value !== undefined) flags[name] = value;
    }
    const details: Record<string, string> = {};
    for (const name of ["steps", "expected", "actual"] as const) {
      const value = optionalText(options, name);
      if (value !== undefined) details[name] = value;
    }
    if (Object.keys(details).length > 0) {
      flags["details"] = { ...(isRecord(base["details"]) ? base["details"] : {}), ...details };
    }
    const target = parseTarget(options["target"]);
    if (target !== undefined) flags["target"] = target;
    const key = optionalText({ "submission-key": options["submissionKey"] }, "submission-key");
    const body: Record<string, unknown> = { ...base, ...flags };
    if (key !== undefined) body["submission_key"] = key;
    else if (body["submission_key"] === undefined || body["submission_key"] === null) {
      body["submission_key"] = randomUUID();
    }
    validateRequestBody(REQUEST_ROUTES.submit, body);
    const evidence = await readEvidence(ctx, (options["evidence"] as string[] | undefined) ?? []);

    const session = await openSession(ctx, global);
    const { data, response } = await sendRequestRoute<RequestReceived>(
      session,
      REQUEST_ROUTES.submit,
      {},
      { body, idempotent: true },
    );
    const id = data.request.id;
    const url = requestUrl(session.target.url, id);
    const attachments: RequestAttachment[] = [];
    if (evidence.length > 0) {
      const owner =
        data.occurrence_id != null
          ? (["occurrence_id", data.occurrence_id] as const)
          : data.entry_id != null
            ? (["entry_id", data.entry_id] as const)
            : undefined;
      if (owner === undefined) {
        throw new CliError(
          "UNEXPECTED_RESPONSE",
          "The server filed the request but named no entry or occurrence to attach the evidence to.",
          ExitCode.Unexpected,
          { request: id, outcome: data.outcome, url },
        );
      }
      for (const item of evidence) {
        const form = new FormData();
        form.append("file", item.file, item.name);
        form.append(owner[0], owner[1]);
        try {
          const { data: stored } = await sendRequestRoute<RequestAttachment>(
            session,
            REQUEST_ROUTES.attach,
            { request_id: encodeURIComponent(id) },
            { form },
          );
          attachments.push(stored);
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          throw new CliError(error.code, error.message, error.exitCode, {
            ...error.details,
            request: id,
            outcome: data.outcome,
            url,
            file: item.path,
            uploaded: attachments.map((stored) => stored.id),
          });
        }
      }
    }
    return {
      data: {
        outcome: data.outcome,
        url,
        request: presentRequest(data.request),
        entry_id: data.entry_id,
        occurrence_id: data.occurrence_id,
        attachments,
      },
      meta: session.meta(response),
    };
  },
};

/**
 * The body `-f` gives: a JSON or YAML object for `.json`, `.yaml` and `.yml` files and for standard
 * input starting with `{`; any other file's text is the `body`.
 */
async function readBase(ctx: RunContext, source: string): Promise<Record<string, unknown>> {
  const structured = [".json", ".yaml", ".yml"].includes(extname(source).toLowerCase());
  let value: unknown;
  if (structured) {
    value = (await readInput(ctx, source)).value;
  } else {
    const text = await readTextInput(ctx, source);
    if (source === "-" && text.trimStart().startsWith("{")) {
      value = parseInput(text, "json", source);
    } else {
      if (text.trim() === "") throw usageError(`${source} is empty; give the request's text.`);
      return { body: text };
    }
  }
  if (!isRecord(value)) {
    throw usageError(`${source} is not an object; give the Request's fields.`, { source });
  }
  return value;
}

/** Reads every evidence file before anything is sent; a missing or unreadable one is a usage error. */
async function readEvidence(ctx: RunContext, paths: string[]): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const given of paths) {
    const trimmed = given.trim();
    if (trimmed === "") throw usageError("--evidence needs a file.", { option: "--evidence" });
    const path = resolve(ctx.cwd, trimmed);
    let bytes: Buffer;
    try {
      if (!(await stat(path)).isFile()) {
        throw usageError(`--evidence ${trimmed} is not a file.`, {
          option: "--evidence",
          file: trimmed,
        });
      }
      bytes = await readFile(path);
    } catch (error) {
      if (error instanceof CliError) throw error;
      const reason = (error as NodeJS.ErrnoException).code ?? String(error);
      throw usageError(
        `Cannot read --evidence ${trimmed}, relative to the working directory: ${reason}.`,
        { option: "--evidence", file: trimmed },
      );
    }
    const type = MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    evidence.push({ name: basename(path), path: trimmed, file: new Blob([bytes], { type }) });
  }
  return evidence;
}
