import { Option, type Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiResponse } from "../../core/http.js";
import { MAX_PAGES, pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type TicketHistory = components["schemas"]["TicketHistory"];

/** The entries `--show` can keep, as the History route's `show` parameter lists them. */
export const HISTORY_SHOWS = ["everything", "people", "observations"] as const;

/** The most entries one History page holds: the route's `limit` is 1 to this. */
export const MAX_HISTORY_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A whole number the route's `after` or `limit` takes, from its option text: digits only, no sign,
 * fraction or exponent. A value outside `min`..`max` is a usage error (exit code 2) and nothing is
 * sent.
 */
export function wholeNumber(
  value: unknown,
  option: string,
  range: { min: number; max?: number; what: string },
): number | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  const number = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (
    !Number.isSafeInteger(number) ||
    number < range.min ||
    (range.max !== undefined && number > range.max)
  ) {
    throw usageError(`${option} takes ${range.what}.`, {
      option,
      ...(text !== "" ? { value: text } : {}),
    });
  }
  return number;
}

/**
 * `pidgen ticket history <ref> [--show everything|people|observations] [--after <n>] [--limit <n>]
 * [--all]`: a ticket's history, oldest first (`GET /tickets/{ref}/history`). `--show`, `--after`
 * and `--limit` are sent as `show`, `after` and `limit`; a flag not given is not sent, so the
 * route's defaults apply (`show` is `everything`, `limit` is 100).
 *
 * Without `--all` the command reads one page and `data` is the server's: `ticket_id`, `entries`
 * and `next_after`, which is the `--after` that reads the next page, or `null` on the last. Each
 * entry's `sequence` is its position in the ticket's whole history and is kept under `--show`.
 * With `--all` it follows `next_after`, asking with the same `--show` and `--limit`, until it is
 * `null`: `data` then holds every entry from `--after` on, in order, with `next_after` `null`, and
 * `meta` is the first page's. A refusal on any page fails the command, so part of a history is
 * never reported as all of it. A `next_after` that does not advance, or pages still coming after
 * `MAX_PAGES`, is `UNEXPECTED_RESPONSE` (exit code 1).
 *
 * An unknown `--show`, an `--after` that is not a whole number from 0, a `--limit` outside 1 to
 * 200, or a missing ticket is a usage error (exit code 2) and sends nothing. An unknown ticket, or
 * another Account's, is `TICKET_NOT_FOUND` (exit code 4). The route needs a server that publishes
 * the ticket History; a server without it answers 404 (exit code 4). See docs/commands.md,
 * "ticket history".
 */
export const ticketHistory: CommandSpec = {
  path: ["ticket", "history"],
  summary: "Read a ticket's history: what happened to it, oldest first",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .addOption(
        new Option(
          "--show <show>",
          "which entries to read: those a person made, those the system recorded, or all (default: everything)",
        ).choices(HISTORY_SHOWS),
      )
      .option("--after <n>", "only entries after this sequence; a page's next_after continues it")
      .option(
        "--limit <n>",
        `the most entries in one page, 1 to ${MAX_HISTORY_LIMIT} (default: the server's 100)`,
      )
      .option("--all", "follow next_after to the end and print every entry");
  },
  async run(ctx, { args, options, global }) {
    const ref = pathSegment("ticket ref", args[0]);
    const show = options["show"] as (typeof HISTORY_SHOWS)[number] | undefined;
    const after = wholeNumber(options["after"], "--after", {
      min: 0,
      what: "a whole number from 0, a sequence from a previous page's next_after",
    });
    const limit = wholeNumber(options["limit"], "--limit", {
      min: 1,
      max: MAX_HISTORY_LIMIT,
      what: `a whole number from 1 to ${MAX_HISTORY_LIMIT}`,
    });
    const all = options["all"] === true;

    const session = await openSession(ctx, global);
    const path = `/tickets/${ref}/history`;
    const page = (cursor: number | undefined) =>
      session.client.request<TicketHistory>({
        method: "GET",
        path,
        query: { show, after: cursor, limit },
      });

    const first = await page(after);
    if (!all) return { data: first.data, meta: session.meta(first) };
    const data = await followToEnd(first, page, { path, after, limit });
    return { data, meta: session.meta(first) };
  },
};

/**
 * Reads every page after `first`, each from the previous page's `next_after`, and returns one
 * history holding all the entries in order and a `next_after` of `null`. The cursor must grow on
 * every page, so a server that repeats one cannot make the command loop.
 */
async function followToEnd(
  first: ApiResponse<TicketHistory>,
  page: (cursor: number | undefined) => Promise<ApiResponse<TicketHistory>>,
  request: { path: string; after: number | undefined; limit: number | undefined },
): Promise<unknown> {
  const entries: unknown[] = [];
  let current = first;
  let cursor = request.after ?? 0;
  for (let pages = 1; ; pages++) {
    const data: unknown = current.data;
    if (!isRecord(data)) throw unexpected(request, "answered a history that is not an object.");
    if (Array.isArray(data["entries"])) entries.push(...(data["entries"] as unknown[]));
    const next = data["next_after"];
    if (next === null || next === undefined) {
      const head: unknown = first.data;
      return { ...(isRecord(head) ? head : {}), entries, next_after: null };
    }
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= cursor) {
      throw unexpected(
        request,
        `answered next_after ${JSON.stringify(next)} after ${cursor}, which does not move on.`,
      );
    }
    if (pages >= MAX_PAGES) {
      throw unexpected(request, `still had pages after ${MAX_PAGES}; pass a larger --limit.`);
    }
    cursor = next;
    current = await page(cursor);
  }
}

function unexpected(request: { path: string; limit: number | undefined }, what: string): CliError {
  return new CliError("UNEXPECTED_RESPONSE", `${request.path} ${what}`, ExitCode.Unexpected, {
    path: request.path,
    max_pages: MAX_PAGES,
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
}
