import { Option, type Command } from "commander";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { ApiResponse } from "../../core/http.js";
import { MAX_PAGES, PAGE_SIZE } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import {
  integerOption,
  parseTarget,
  presentRequest,
  REQUEST_KINDS,
  REQUEST_ROUTES,
  REQUEST_STATES,
  sendRequestRoute,
  type Request,
} from "../../core/requests.js";
import { openSession } from "../../core/session.js";
import { filterValue } from "../ticket/list.js";

/**
 * `pidgen request list [--state <state>] [--kind <kind>] [--target <kind>:<id>] [--source <id>]
 * [--query <text>] [--page <n>] [--per-page <n>]`: the Requests the caller may read
 * (`GET /requests`), newest first. The filters are sent as `state`, `kind`, `target_kind` and
 * `target_id`, `source_id` and `q`. Without `--page` every page is followed to the last, as for
 * `pidgen ticket list`; with it (and `--per-page`, 1–100) only that page is read. Each Request is
 * validated against the published document.
 */
export const requestList: CommandSpec = {
  path: ["request", "list"],
  summary: "List Requests by state, kind, target and source",
  configure(command: Command) {
    command
      .addOption(
        new Option("--state <state>", "only Requests in this state").choices(REQUEST_STATES),
      )
      .addOption(new Option("--kind <kind>", "only Requests of this kind").choices(REQUEST_KINDS))
      .option("--target <kind:id>", "only Requests aimed at project:<id> or domain:<id>")
      .option("--source <id>", "only Requests submitted through this source")
      .option("--query <text>", "only Requests whose title or body has these words")
      .option("--page <n>", "read only this page (1-based)")
      .option("--per-page <n>", "the page size with --page, 1-100 (default: 20)");
  },
  async run(ctx, { options, global }) {
    const target = parseTarget(options["target"]);
    const query = {
      state: options["state"] as string | undefined,
      kind: options["kind"] as string | undefined,
      target_kind: target?.kind,
      target_id: target?.id,
      source_id: filterValue("--source", options["source"]),
      q: filterValue("--query", options["query"]),
    };
    const page = integerOption(options["page"], "--page", 1);
    const perPage = integerOption(options["perPage"], "--per-page", 1, PAGE_SIZE);
    const session = await openSession(ctx, global);
    if (page !== undefined || perPage !== undefined) {
      const { data, response } = await sendRequestRoute<Request[]>(
        session,
        REQUEST_ROUTES.list,
        {},
        {
          query: { ...query, page, per_page: perPage },
        },
      );
      return { data: data.map(presentRequest), meta: session.meta(response) };
    }
    const items: Request[] = [];
    let first: ApiResponse | undefined;
    for (let next = 1; ; next++) {
      if (next > MAX_PAGES) {
        throw new CliError(
          "UNEXPECTED_RESPONSE",
          `/requests still returned full pages after ${MAX_PAGES} pages.`,
          ExitCode.Unexpected,
          { path: "/requests", pages: MAX_PAGES, per_page: PAGE_SIZE },
        );
      }
      const { data, response } = await sendRequestRoute<Request[]>(
        session,
        REQUEST_ROUTES.list,
        {},
        {
          query: { ...query, page: next, per_page: PAGE_SIZE },
        },
      );
      first ??= response;
      items.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    return { data: items.map(presentRequest), meta: session.meta(first) };
  },
};
