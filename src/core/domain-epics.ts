import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiRequest } from "./http.js";
import { schemaIssues } from "./input.js";
import type { CommandResult } from "./registry.js";
import { openSession } from "./session.js";
import type { components } from "../generated/api.js";

/**
 * Initiatives (Domain Epics, as the API calls them) as the published document
 * (`contracts/openapi.json`) states them: `POST /api/v1/tickets` with `domain_id` instead of
 * `project_id` files an Initiative, and
 * `GET /api/v1/domains/{domain_id}/epics` reads a domain's Epics. The create body is validated
 * against the published `CreateTicketRequest`, which carries `domain_id`; the Epics read's `data`
 * against the published `DomainEpicBoard`.
 */

export type DomainEpicBoard = components["schemas"]["DomainEpicBoard"];

/** The domain Epics read, as the published document names it. */
export const DOMAIN_EPICS_ROUTE = { method: "GET", path: "/domains/{domain_id}/epics" } as const;

/** The fields an Initiative's file may not name: the domain stands in for the project and branch. */
export const DOMAIN_EPIC_REFUSED_FIELDS = ["project_id", "branch_mode", "feature_branch"] as const;

/**
 * Reads a domain's Epics (`GET /domains/{domain_id}/epics`) with `query`; `domain` is already a
 * checked, percent-encoded path segment. The answer is validated against the published
 * `DomainEpicBoard`: a body that does not match is `UNEXPECTED_RESPONSE` (exit 1). A server refusal
 * keeps its own code and exit code.
 */
export async function readDomainEpics(
  ctx: RunContext,
  global: GlobalOptions,
  domain: string,
  query: NonNullable<ApiRequest["query"]>,
): Promise<CommandResult> {
  const session = await openSession(ctx, global);
  const response = await session.client.request<unknown>({
    method: DOMAIN_EPICS_ROUTE.method,
    path: DOMAIN_EPICS_ROUTE.path.replace("{domain_id}", domain),
    query,
  });
  const issues = schemaIssues(
    PUBLIC_API_DOCUMENT,
    { $ref: "#/components/schemas/DomainEpicBoard" },
    response.data,
  );
  if (issues.length > 0) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's Initiatives do not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      ExitCode.Unexpected,
      { route: `${DOMAIN_EPICS_ROUTE.method} /api/v1${DOMAIN_EPICS_ROUTE.path}`, issues },
    );
  }
  return { data: response.data as DomainEpicBoard, meta: session.meta(response) };
}
