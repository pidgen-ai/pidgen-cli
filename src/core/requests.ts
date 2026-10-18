import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../commands/api/document.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiRequest, ApiResponse, HttpMethod } from "./http.js";
import { schemaIssues, validateBody } from "./input.js";
import { pathSegment } from "./read.js";
import type { CommandResult } from "./registry.js";
import { openSession, type Session } from "./session.js";
import type { components } from "../generated/api.js";

/**
 * The Request routes: submit a Request, list and read Requests and their timelines, triage them
 * (acknowledge, ask, reply, accept, close, promote) and attach evidence files. Every body is
 * validated against the published document before it is sent and every answer after.
 */

export type Request = components["schemas"]["Request"];
/**
 * A Request as the commands print it: named by its key (`REQ-{n}`) in `id`, and its duplicate by
 * its key in `duplicate_of`, never by the internal `conv-` id unless the server has no key for it.
 */
export type ShownRequest = Omit<Request, "request_key" | "duplicate_of_key">;
export type RequestSubmitRequest = components["schemas"]["RequestSubmitRequest"];
export type RequestReceived = components["schemas"]["RequestReceived"];
export type RequestAttachment = components["schemas"]["RequestAttachment"];
export type RequestTimelineEntry = components["schemas"]["RequestTimelineEntry"];
export type RequestTarget = components["schemas"]["RequestTargetInput"];
type SchemaName = keyof components["schemas"];

export const REQUEST_KINDS = [
  "bug",
  "feature",
  "task",
  "question",
] as const satisfies readonly Request["kind"][];
export const REQUEST_STATES = [
  "new",
  "acknowledged",
  "accepted",
  "promoted",
  "resolved",
  "closed",
] as const satisfies readonly Request["state"][];
export const REQUEST_URGENCIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const satisfies readonly Request["urgency"][];
export const REQUEST_PRIORITIES = ["P1", "P2", "P3", "P4"] as const satisfies readonly NonNullable<
  Request["priority"]
>[];
export const DETAIL_FIELDS = ["steps", "expected", "actual"] as const;
export const CLOSE_REASONS = [
  "cannot_reproduce",
  "wont_do",
  "duplicate",
  "invalid",
  "answered",
  "no_response",
  "withdrawn",
  "other",
] as const satisfies readonly components["schemas"]["RequestCloseRequest"]["reason"][];

export interface RequestRoute {
  method: HttpMethod;
  /** The route's path template under `/api/v1`. */
  path: string;
  /** The published schema of what the route answers in `data`, or a list of it. */
  answers: SchemaName | { list: SchemaName };
  /** How the answer is named when it does not match. */
  what: string;
}

/** Every Request operation a command sends, as the published document names it. */
export const REQUEST_ROUTES = {
  submit: { method: "POST", path: "/requests", answers: "RequestReceived", what: "submission" },
  list: { method: "GET", path: "/requests", answers: { list: "Request" }, what: "request list" },
  show: { method: "GET", path: "/requests/{request_id}", answers: "Request", what: "request" },
  timeline: {
    method: "GET",
    path: "/requests/{request_id}/timeline",
    answers: { list: "RequestTimelineEntry" },
    what: "timeline",
  },
  attach: {
    method: "POST",
    path: "/requests/{request_id}/attachments",
    answers: "RequestAttachment",
    what: "attachment",
  },
  acknowledge: {
    method: "POST",
    path: "/requests/{request_id}/acknowledge",
    answers: "Request",
    what: "request",
  },
  ask: { method: "POST", path: "/requests/{request_id}/ask", answers: "Request", what: "request" },
  reply: {
    method: "POST",
    path: "/requests/{request_id}/reply",
    answers: "RequestEntryWritten",
    what: "reply",
  },
  accept: {
    method: "POST",
    path: "/requests/{request_id}/accept",
    answers: "Request",
    what: "request",
  },
  close: {
    method: "POST",
    path: "/requests/{request_id}/close",
    answers: "Request",
    what: "request",
  },
  promote: {
    method: "POST",
    path: "/requests/{request_id}/promote",
    answers: "RequestPromotion",
    what: "promotion",
  },
} as const satisfies Record<string, RequestRoute>;

/**
 * Each Request refusal the server states, the sentence the CLI prints for it in `error.message`
 * (the server's own message is kept in `error.details.server_message`) and its exit code, which
 * holds whatever HTTP status the server answers with (src/core/errors.ts).
 */
export const REQUEST_REFUSALS = {
  REQUEST_NOT_FOUND: {
    sentence: "No such request in this Account, or one you may not see.",
    exit: ExitCode.NotFound,
  },
  REQUEST_VERSION_CONFLICT: {
    sentence: "The request changed since it was read; show it again and retry.",
    exit: ExitCode.Refused,
  },
  REQUEST_TRANSITION_REFUSED: {
    sentence: "The request's state does not allow that; a promoted request no longer changes.",
    exit: ExitCode.Refused,
  },
  REQUEST_RATE_LIMITED: {
    sentence: "Too many requests came through this source; wait and submit again.",
    exit: ExitCode.Refused,
  },
  REQUEST_SOURCE_PAUSED: {
    sentence: "The source this credential submits through is paused; nothing was filed.",
    exit: ExitCode.Refused,
  },
  REQUEST_BUG_DETAILS_REQUIRED: {
    sentence:
      "A bug is accepted only with its steps, expected and actual results; name the missing ones with --unknown.",
    exit: ExitCode.Refused,
  },
  REQUEST_TARGET_NEEDS_PROJECT: {
    sentence:
      "The request does not target that Project, or targets a Domain or nothing; move it to a Project first.",
    exit: ExitCode.Refused,
  },
  REQUEST_REPLIES_OFF: {
    sentence: "The request's source does not carry replies to the requester; add a note instead.",
    exit: ExitCode.Refused,
  },
} as const satisfies Record<string, { sentence: string; exit: ExitCode }>;

/** A server refusal with its stated sentence, when it is a Request refusal; anything else as is. */
export function withSentence(error: unknown): unknown {
  if (!(error instanceof CliError) || !Object.hasOwn(REQUEST_REFUSALS, error.code)) return error;
  const { sentence } = REQUEST_REFUSALS[error.code as keyof typeof REQUEST_REFUSALS];
  return new CliError(error.code, sentence, error.exitCode, {
    ...error.details,
    server_message: error.message,
  });
}

/**
 * Sends one Request route on `session`: `params` fill the path template (each already a checked,
 * percent-encoded segment). The answer's `data` is validated against the published document: one
 * that does not match is `UNEXPECTED_RESPONSE` (exit 1). A Request refusal prints its sentence.
 */
export async function sendRequestRoute<T = unknown>(
  session: Session,
  route: RequestRoute,
  params: Record<string, string> = {},
  extra: Pick<ApiRequest, "body" | "query" | "form" | "idempotent"> = {},
): Promise<{ data: T; response: ApiResponse }> {
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for {${name}} in ${route.path}`);
    return value;
  });
  let response: ApiResponse;
  try {
    response = await session.client.request<unknown>({ method: route.method, path, ...extra });
  } catch (error) {
    throw withSentence(error);
  }
  const schema =
    typeof route.answers === "string"
      ? { $ref: `#/components/schemas/${route.answers}` }
      : { type: "array", items: { $ref: `#/components/schemas/${route.answers.list}` } };
  const issues = schemaIssues(PUBLIC_API_DOCUMENT, schema, response.data);
  if (issues.length > 0) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's ${route.what} does not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      ExitCode.Unexpected,
      { route: `${route.method} /api/v1${route.path}`, issues },
    );
  }
  return { data: response.data as T, response };
}

/** Validates a body against the route's published request schema (`INPUT_INVALID`, exit 2). */
export function validateRequestBody(route: RequestRoute, body: unknown): void {
  validateBody(PUBLIC_API_DOCUMENT, route.method, route.path, body);
}

/**
 * The `<request>` argument every command on one Request takes: its key, `REQ-{n}`. The server
 * resolves it inside the Account; the CLI sends it as given.
 */
export function requestArgument(command: Command): Command {
  return command.argument("<request>", "the request: its key, e.g. REQ-12");
}

/** The `<request>` argument as one checked, percent-encoded path segment. */
export function requestSegment(args: string[]): string {
  return pathSegment("request", args[0]);
}

/** How a Request is named to people: its key (`REQ-{n}`), or its id only when it has no key. */
export function requestName(request: Pick<Request, "id" | "request_key">): string {
  return request.request_key ?? request.id;
}

/**
 * The Request's page on the server: `<server>/requests/<key>?account=<account>`, without the
 * Account when none is selected.
 */
export function requestUrl(server: string, key: string, account: string | null = null): string {
  const page = `${server.replace(/\/+$/, "")}/requests/${encodeURIComponent(key)}`;
  return account === null ? page : `${page}?account=${encodeURIComponent(account)}`;
}

/**
 * `--target <kind>:<id>`: `project:<id>` or `domain:<id>`; a bare id is a Project. An empty value
 * or another kind is a usage error (exit 2).
 */
export function parseTarget(value: unknown, option = "--target"): RequestTarget | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const match = /^([a-z]+):(.*)$/.exec(text);
  const kind = match ? match[1] : "project";
  const id = (match ? match[2]! : text).trim();
  if (kind !== "project" && kind !== "domain") {
    throw usageError(`${option} is project:<id> or domain:<id>, not ${text}.`, {
      option,
      value: text,
    });
  }
  if (id === "") throw usageError(`${option} needs an id.`, { option });
  return { kind, id };
}

/** A whole number option within bounds; anything else is a usage error (exit 2). */
export function integerOption(
  value: unknown,
  option: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < min || number > max) {
    throw usageError(
      `${option} is a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ""}.`,
      {
        option,
        value: text,
      },
    );
  }
  return number;
}

/**
 * A Request as the commands print it: named by its key in `id` and its duplicate by its key in
 * `duplicate_of` (the ids only when the server has no key), and its requester's contact left out
 * when the server withholds it (null). A promoted Request's Ticket keeps its `ticket_key`.
 */
export function presentRequest(request: Request): ShownRequest {
  const { request_key: key, duplicate_of_key: duplicateKey, ...rest } = request;
  const shown: ShownRequest = {
    ...rest,
    id: key ?? request.id,
    duplicate_of: duplicateKey ?? request.duplicate_of,
  };
  if (request.requester === null || request.requester.contact !== null) return shown;
  // The contact is withheld from this caller: say nothing rather than null.
  const requester: Partial<NonNullable<Request["requester"]>> = { ...request.requester };
  delete requester.contact;
  return { ...shown, requester: requester as Request["requester"] };
}

/**
 * An intent answer as the intent commands print it: an object carrying `request_key` names its
 * request by that key in `request_id` and `conversation_id` (the ids only when the key is null),
 * and a nested `request` likewise. Anything else is returned as is.
 */
export function presentIntent<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => presentIntent(item)) as T;
  if (!isRecord(value)) return value;
  const { request_key: own, ...shown } = value as Record<string, unknown>;
  const inner = value["request"];
  // A clarification names the same request at its top and in `request`; either key names both.
  const key = own ?? (isRecord(inner) ? inner["request_key"] : undefined);
  if (isRecord(inner)) shown["request"] = presentIntent(inner);
  if (typeof key === "string") {
    for (const field of ["request_id", "conversation_id"]) {
      if (typeof shown[field] === "string") shown[field] = key;
    }
  }
  return shown as T;
}

/**
 * A triage write: reads the Request for its `version` (`GET /requests/{request_id}`), sends the
 * route with `body` and that version, and answers the server's `data` with the Request's new
 * `state` at its top. A body the document refuses is `INPUT_INVALID` (exit 2) and is not sent.
 */
export async function triageRequest(
  ctx: RunContext,
  global: GlobalOptions,
  args: string[],
  route: RequestRoute,
  body: Record<string, unknown> = {},
): Promise<CommandResult> {
  const id = requestSegment(args);
  // Checked before anything is sent, with a placeholder version the read replaces.
  validateRequestBody(route, { version: 0, ...body });
  const session = await openSession(ctx, global);
  const { data: current } = await sendRequestRoute<Request>(session, REQUEST_ROUTES.show, {
    request_id: id,
  });
  const sent = { version: current.version, ...body };
  const { data, response } = await sendRequestRoute<Record<string, unknown>>(
    session,
    route,
    { request_id: id },
    { body: sent },
  );
  const request = (isRecord(data["request"]) ? data["request"] : data) as Request;
  if (request === data) return { data: presentRequest(request), meta: session.meta(response) };
  const answer: Record<string, unknown> = {
    state: request.state,
    ...data,
    request: presentRequest(request),
  };
  // A promotion names its Ticket by key beside its id, as the promoted Request does.
  if ("ticket_id" in data && request.promoted?.kind === "ticket") {
    answer["ticket_key"] = request.promoted.ticket_key;
  }
  return { data: answer, meta: session.meta(response) };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
