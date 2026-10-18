import { ExitCode } from "./exit-codes.js";

export type ErrorDetails = Record<string, unknown>;

/** Every failure the CLI reports. `code` becomes `error.code` in the envelope. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: ErrorDetails;
  /**
   * What a terminal shows on standard output in place of the generic rendering of this error, when
   * the command has already told the person (as `pidgen setup` draws its own failure block). JSON
   * output is unaffected.
   */
  human?: string;

  constructor(code: string, message: string, exitCode: ExitCode, details: ErrorDetails = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(message: string, details: ErrorDetails = {}): CliError {
  return new CliError("CLI_USAGE", message, ExitCode.Usage, details);
}

/** Server error codes that mean "preview again or acknowledge", whatever the HTTP status. */
const CONFIRMATION_CODES = new Set([
  "PREVIEW_STALE",
  "ACKNOWLEDGEMENT_REQUIRED",
  "DIGEST_REQUIRED",
]);

/**
 * Server error codes that are domain refusals whatever the HTTP status, so they exit 5 even when
 * the status would not: a person who may not withdraw an intake request is refused, not
 * unauthenticated (403); a request that already became a Ticket names it (409); the domain graph
 * refusals are refusals whether the server answers 409 or 422.
 */
const REFUSAL_CODES = new Set([
  "REQUEST_WITHDRAW_FORBIDDEN",
  "REQUEST_ALREADY_CREATED",
  "DOMAIN_CYCLE",
  "DOMAIN_TOO_DEEP",
  "DOMAIN_IS_ACCOUNT_ROOT",
  "DOMAIN_COVERAGE_IN_USE",
  "DOMAIN_HAS_OPEN_EPICS",
  // A domain that contains no project has no home for a Domain Epic: its state, not the request.
  "DOMAIN_HAS_NO_PROJECTS",
  // A contract link the server refuses writes nothing, whichever status it answers with.
  "CONTRACT_LINK_NOT_DELIVERY_ROOT",
  "CONTRACT_LINK_OUTSIDE_PROVIDER",
  "CONTRACT_LINK_OWN_PROVIDER",
  "CONTRACT_LINK_INSIDE_COHORT",
  "CONTRACT_DEPRECATED",
  "CONTRACT_RETIRED",
  "CONTRACT_UNKNOWN_OPERATION",
  // A Request write the server refuses changes nothing: a stale version, a move the Request's
  // state does not allow, a paused or rate-limited source, or a precondition of accept, promote or
  // reply. Each is a refusal whichever status the server answers it with.
  "REQUEST_VERSION_CONFLICT",
  "REQUEST_TRANSITION_REFUSED",
  "REQUEST_RATE_LIMITED",
  "REQUEST_SOURCE_PAUSED",
  "REQUEST_BUG_DETAILS_REQUIRED",
  "REQUEST_TARGET_NEEDS_PROJECT",
  "REQUEST_REPLIES_OFF",
]);

/**
 * Server error codes that mean "no such thing, or none you may see" whatever the HTTP status: a
 * Request the caller cannot see is not found, never forbidden.
 */
const NOT_FOUND_CODES = new Set(["REQUEST_NOT_FOUND"]);

/** Maps an HTTP error response onto an exit code. */
export function exitCodeForResponse(status: number, code?: string): ExitCode {
  if (code !== undefined && CONFIRMATION_CODES.has(code)) return ExitCode.ConfirmationRequired;
  if (code !== undefined && REFUSAL_CODES.has(code)) return ExitCode.Refused;
  if (code !== undefined && NOT_FOUND_CODES.has(code)) return ExitCode.NotFound;
  if (status === 400 || status === 422) return ExitCode.Usage;
  if (status === 401 || status === 403) return ExitCode.Auth;
  if (status === 404 || status === 410) return ExitCode.NotFound;
  if (status === 409 || status === 412 || status === 423) return ExitCode.Refused;
  if (status === 426) return ExitCode.VersionIncompatible;
  if (status === 408 || status === 504) return ExitCode.Network;
  return ExitCode.Unexpected;
}

/** Fallback `error.code` when the server gave none. */
export function defaultCodeForStatus(status: number): string {
  switch (exitCodeForResponse(status)) {
    case ExitCode.Usage:
      return "INPUT_INVALID";
    case ExitCode.Auth:
      return status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN";
    case ExitCode.NotFound:
      return "NOT_FOUND";
    case ExitCode.Refused:
      return "CONFLICT";
    case ExitCode.VersionIncompatible:
      return "API_VERSION_UNSUPPORTED";
    case ExitCode.Network:
      return "TIMEOUT";
    default:
      return "UNEXPECTED_RESPONSE";
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("CLI_INTERNAL", message, ExitCode.Unexpected);
}
