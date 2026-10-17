import type { GlobalOptions, RunContext } from "./context.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiRequest, ApiResponse } from "./http.js";
import type { CommandResult } from "./registry.js";
import { openSession } from "./session.js";

/**
 * The shared shape of a read command: one `GET` to a public route with the selected profile's
 * credential and Account. The envelope's `data` is the server's `data` unchanged, and `meta`
 * carries the server's `request_id` and `api_version` with the profile and Account. A server
 * refusal keeps its own code and exit code (see docs/output-and-exit-codes.md).
 */
export async function readRoute<T>(
  ctx: RunContext,
  global: GlobalOptions,
  path: string,
  query?: ApiRequest["query"],
): Promise<CommandResult & { data: T }> {
  const session = await openSession(ctx, global);
  const response = await session.client.request<T>({
    method: "GET",
    path,
    ...(query ? { query } : {}),
  });
  return { data: response.data, meta: session.meta(response) };
}

/**
 * One path parameter of a read command, such as a project key, checked and percent-encoded so it
 * stays a single path segment. A missing, empty, `.` or `..` value is a usage error (exit code 2)
 * and nothing is sent.
 */
export function pathSegment(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") throw usageError(`A ${name} is required.`, { argument: name });
  if (trimmed === "." || trimmed === "..") {
    throw usageError(`Not a valid ${name}: ${trimmed}`, { argument: name, value: trimmed });
  }
  return encodeURIComponent(trimmed);
}

/** The page size a paged read asks for: the largest the public list routes accept. */
export const PAGE_SIZE = 100;

/** The most pages a paged read follows before refusing to go on (a server ignoring `page`). */
export const MAX_PAGES = 1000;

/**
 * A paged read command: `GET` a public list route page by page (`page`, `per_page`) with the same
 * filters, and return every item in order. It stops at the first page holding fewer than
 * `PAGE_SIZE` items, the last page. `meta` comes from the first response. A refusal on any page
 * fails the whole command, so a partial list is never reported as complete. A list that is still
 * full after `MAX_PAGES` pages is `UNEXPECTED_RESPONSE` (exit code 1).
 */
export async function readAllPages<T>(
  ctx: RunContext,
  global: GlobalOptions,
  path: string,
  query: ApiRequest["query"] = {},
): Promise<CommandResult & { data: T[] }> {
  const session = await openSession(ctx, global);
  const items: T[] = [];
  let first: ApiResponse<T[]> | undefined;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        `${path} still returned full pages after ${MAX_PAGES} pages.`,
        ExitCode.Unexpected,
        { path, pages: MAX_PAGES, per_page: PAGE_SIZE },
      );
    }
    const response = await session.client.request<T[]>({
      method: "GET",
      path,
      query: { ...query, page, per_page: PAGE_SIZE },
    });
    first ??= response;
    const rows = Array.isArray(response.data) ? response.data : [];
    items.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return { data: items, meta: session.meta(first) };
}
