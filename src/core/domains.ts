import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { HttpMethod } from "./http.js";
import { schemaIssues, validateBody } from "./input.js";
import { pathSegment } from "./read.js";
import type { CommandResult } from "./registry.js";
import { openSession } from "./session.js";
import type { components } from "../generated/api.js";

/**
 * The domain routes of the published document (`contracts/openapi.json`): `/api/v1/domains` and
 * the routes under one domain. Every request body is validated against the document before it is
 * sent and every answer's `data` after: a list of `DomainResource`, or one `DomainDetail` (the
 * resource and the people granted on it). Each domain counts its people under `people`
 * (`members`, `maintainers`) and its Epics under `epics` (`open`, `total`).
 */

export type Domain = components["schemas"]["DomainResource"];
export type DomainDetail = components["schemas"]["DomainDetail"];
export type CreateDomainRequest = components["schemas"]["DomainCreateRequest"];
export type EditDomainRequest = components["schemas"]["DomainUpdateRequest"];
export type DomainPersonRequest = components["schemas"]["DomainPersonRequest"];

export interface DomainRoute {
  method: HttpMethod;
  /** The route's path template under `/api/v1`. */
  path: string;
  /** What the route answers: one domain or the list of them. */
  answers: "domain" | "list";
}

/** Every domain operation, as the published document names it. */
export const DOMAIN_ROUTES = {
  list: { method: "GET", path: "/domains", answers: "list" },
  create: { method: "POST", path: "/domains", answers: "domain" },
  show: { method: "GET", path: "/domains/{domain_id}", answers: "domain" },
  edit: { method: "PATCH", path: "/domains/{domain_id}", answers: "domain" },
  projectAdd: {
    method: "PUT",
    path: "/domains/{domain_id}/projects/{project_ref}",
    answers: "domain",
  },
  projectRm: {
    method: "DELETE",
    path: "/domains/{domain_id}/projects/{project_ref}",
    answers: "domain",
  },
  parentAdd: { method: "PUT", path: "/domains/{domain_id}/parents/{parent_id}", answers: "domain" },
  parentRm: {
    method: "DELETE",
    path: "/domains/{domain_id}/parents/{parent_id}",
    answers: "domain",
  },
  personPut: { method: "PUT", path: "/domains/{domain_id}/people/{user_id}", answers: "domain" },
  personRm: { method: "DELETE", path: "/domains/{domain_id}/people/{user_id}", answers: "domain" },
} as const satisfies Record<string, DomainRoute>;

/** What each kind of answer carries in `data`, as the published responses state it. */
const SCHEMAS = {
  domain: { $ref: "#/components/schemas/DomainDetail" },
  list: { type: "array", items: { $ref: "#/components/schemas/DomainResource" } },
};

/**
 * Sends one domain request: `params` fill the route's path template (each already a checked,
 * percent-encoded segment from `pathSegment`), and `body`, when given, is validated against the
 * published request schema first (`INPUT_INVALID`, exit 2, and nothing is sent). The answer is
 * validated against the published document: a body that does not match is `UNEXPECTED_RESPONSE`
 * (exit 1). A server refusal keeps its own code and exit code.
 */
export async function domainRequest(
  ctx: RunContext,
  global: GlobalOptions,
  route: DomainRoute,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<CommandResult> {
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for {${name}} in ${route.path}`);
    return value;
  });
  if (body !== undefined) validateBody(PUBLIC_API_DOCUMENT, route.method, route.path, body);
  const session = await openSession(ctx, global);
  const response = await session.client.request<unknown>({
    method: route.method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  const issues = schemaIssues(PUBLIC_API_DOCUMENT, SCHEMAS[route.answers], response.data);
  if (issues.length > 0) {
    const what = route.answers === "list" ? "domain list" : "domain";
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's ${what} does not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      ExitCode.Unexpected,
      { route: `${route.method} /api/v1${route.path}`, issues },
    );
  }
  return { data: response.data, meta: session.meta(response) };
}

/** The `<domain>` argument every command under one domain takes. */
export function domainArgument(command: Command): Command {
  return command.argument("<domain>", "the domain: its key, e.g. PAY, or its id (dom-…)");
}

/** The `<domain>` argument as one checked, percent-encoded path segment. */
export function domainSegment(args: string[]): string {
  return pathSegment("domain", args[0]);
}

/**
 * The value of a text option, trimmed: `undefined` when not given, and a usage error (exit 2) when
 * given empty.
 */
export function optionalText(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  if (value === undefined) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") throw usageError(`--${name} needs a value.`, { option: `--${name}` });
  return trimmed;
}

/** The value of a text option that must be given; missing or empty is a usage error (exit 2). */
export function requiredText(options: Record<string, unknown>, name: string): string {
  const value = optionalText(options, name);
  if (value === undefined) throw usageError(`--${name} is required.`, { option: `--${name}` });
  return value;
}

/** Collects a repeatable option's values in order. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Configures `<domain> <other>` for the commands that link a domain to one other thing (a project,
 * a parent domain or a person) and reads both as path segments.
 */
export function configurePair(argument: string, description: string) {
  return (command: Command): void => {
    domainArgument(command).argument(`<${argument}>`, description);
  };
}

export function pairSegments(args: string[], name: string): [string, string] {
  return [domainSegment(args), pathSegment(name, args[1])];
}
