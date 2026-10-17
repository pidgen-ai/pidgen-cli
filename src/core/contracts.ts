import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { HttpMethod } from "./http.js";
import { schemaIssues, validateBody, type OpenApiDocument } from "./input.js";
import { pathSegment } from "./read.js";
import type { CommandResult } from "./registry.js";
import { openSession, type Session } from "./session.js";
import type { components } from "../generated/api.js";

/**
 * The contract routes of the published document (`contracts/openapi.json`): a project's and a
 * domain's contracts, creating one for a project or a domain, one contract with its revisions,
 * linked work and each operation's state, revising a contract,
 * accepting a waiting revision, and linking a ticket to a contract (implements or builds against)
 * or removing the link. Every request body is validated against the document before it is sent
 * and every answer's `data` after.
 *
 * A contract names its `provider` by `project_id`, `kind` (`project` or `domain`), `domain_id`
 * (null for a project's), `key` and `name`, and its owner by `owner_user_id`. A revision is
 * accepted by its `revision_number`. Revise and accept answer the whole contract; a link write
 * answers the Ticket's contracts.
 */

export type Contract = components["schemas"]["ContractDetail"];
export type ContractSummary = components["schemas"]["ContractSummaryResource"];
export type ContractRevision = components["schemas"]["ContractRevisionResource"];
export type ProjectContracts = components["schemas"]["ProjectContractsResource"];
export type DomainContracts = components["schemas"]["DomainContractsResource"];
export type ContractRevisionRequest = components["schemas"]["ContractRevisionRequest"];
export type ContractCreateRequest = components["schemas"]["ContractCreateRequest"];
export type TicketContracts = components["schemas"]["TicketContractsResource"];
export type ContractLinkRequest = components["schemas"]["TicketContractLinkRequest"];

export interface ContractRoute {
  method: HttpMethod;
  /** The route's path template under `/api/v1`. */
  path: string;
  /**
   * The schema of what the route answers in `data`, by its name in the route's document: a
   * published schema, or one a pending fragment states.
   */
  answers: keyof components["schemas"] | (string & {});
  /** How the answer is named when it does not match. */
  what: string;
  /**
   * The document the route's body and answer are validated against: the published one unless
   * the route is agreed and not yet published, when it is the pending fragment that states it.
   */
  document?: OpenApiDocument;
}

/** Every contract operation, as the published document names it. */
export const CONTRACT_ROUTES = {
  projectList: {
    method: "GET",
    path: "/projects/{project_ref}/contracts",
    answers: "ProjectContractsResource",
    what: "contract list",
  },
  domainList: {
    method: "GET",
    path: "/domains/{domain_id}/contracts",
    answers: "DomainContractsResource",
    what: "contract list",
  },
  /** A contract a Project provides. */
  projectCreate: {
    method: "POST",
    path: "/projects/{project_ref}/contracts",
    answers: "ContractDetail",
    what: "created contract",
  },
  /** A contract a Domain provides, its provider being the Domain's home. */
  domainCreate: {
    method: "POST",
    path: "/domains/{domain_id}/contracts",
    answers: "ContractDetail",
    what: "created contract",
  },
  show: {
    method: "GET",
    path: "/contracts/{contract_id}",
    answers: "ContractDetail",
    what: "contract",
  },
  revise: {
    method: "POST",
    path: "/contracts/{contract_id}/revisions",
    answers: "ContractDetail",
    what: "contract",
  },
  accept: {
    method: "POST",
    path: "/contracts/{contract_id}/revisions/{revision_number}/accept",
    answers: "ContractDetail",
    what: "contract",
  },
  link: {
    method: "POST",
    path: "/tickets/{ticket_id}/contracts",
    answers: "TicketContractsResource",
    what: "ticket's contracts",
  },
  unlink: {
    method: "DELETE",
    path: "/tickets/{ticket_id}/contracts/{contract_id}",
    answers: "TicketContractsResource",
    what: "ticket's contracts",
  },
} as const satisfies Record<string, ContractRoute>;

/**
 * Sends one contract request on `session`: `params` fill the route's path template (each already a
 * checked, percent-encoded segment), with a JSON `body` or a multipart `form`. The answer's `data` is validated against the route's
 * schema in its document (the published one, unless the route is pending): a body that does not match is `UNEXPECTED_RESPONSE` (exit 1). A server refusal
 * keeps its own code and exit code.
 */
export async function sendContractRequest<T = unknown>(
  session: Session,
  route: ContractRoute,
  params: Record<string, string> = {},
  body?: unknown,
  form?: FormData,
): Promise<{ data: T; result: CommandResult }> {
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for {${name}} in ${route.path}`);
    return value;
  });
  const response = await session.client.request<unknown>({
    method: route.method,
    path,
    ...(body !== undefined ? { body } : {}),
    ...(form !== undefined ? { form } : {}),
  });
  const issues = schemaIssues(
    route.document ?? PUBLIC_API_DOCUMENT,
    { $ref: `#/components/schemas/${route.answers}` },
    response.data,
  );
  if (issues.length > 0) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's ${route.what} does not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      ExitCode.Unexpected,
      { route: `${route.method} /api/v1${route.path}`, issues },
    );
  }
  return {
    data: response.data as T,
    result: { data: response.data, meta: session.meta(response) },
  };
}

/**
 * Validates `body`, when given, against the route's request schema in its document (`INPUT_INVALID`,
 * exit 2, and nothing is sent), then opens a session and sends it.
 */
export async function contractRequest(
  ctx: RunContext,
  global: GlobalOptions,
  route: ContractRoute,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<CommandResult> {
  if (body !== undefined) {
    validateBody(route.document ?? PUBLIC_API_DOCUMENT, route.method, route.path, body);
  }
  const session = await openSession(ctx, global);
  return (await sendContractRequest(session, route, params, body)).result;
}

/** The `<contract>` argument every command on one contract takes. */
export function contractArgument(command: Command): Command {
  return command.argument("<contract>", "the contract: its key, e.g. CT-7, or its id");
}

/** The `<contract>` argument as one checked, percent-encoded path segment. */
export function contractSegment(args: string[]): string {
  return pathSegment("contract", args[0]);
}

/**
 * The text of a file an option names, relative to the working directory, for `what` (e.g. "a
 * revision needs its text"). A missing, unreadable or empty file is a usage error (exit 2).
 */
export async function readOptionFile(
  ctx: RunContext,
  option: string,
  name: string,
  empty: string,
): Promise<string> {
  const trimmed = name.trim();
  if (trimmed === "") throw usageError(`${option} needs a file.`, { option });
  const file = resolve(ctx.cwd, trimmed);
  let text: string;
  try {
    if (!(await stat(file)).isFile()) {
      throw usageError(`${option} ${trimmed} is not a file.`, { option, file: trimmed });
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    throw usageError(
      `Cannot read ${option} ${trimmed}, relative to the working directory: ${reason}.`,
      { option, file: trimmed },
    );
  }
  if (text.trim() === "") {
    throw usageError(`${option} ${trimmed} is empty; ${empty}.`, { option, file: trimmed });
  }
  return text;
}
