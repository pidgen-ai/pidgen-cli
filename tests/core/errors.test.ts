import { describe, expect, it } from "vitest";
import { exitCodeForResponse, toCliError, CliError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";

describe("exitCodeForResponse", () => {
  it.each([
    [400, ExitCode.Usage],
    [422, ExitCode.Usage],
    [401, ExitCode.Auth],
    [403, ExitCode.Auth],
    [404, ExitCode.NotFound],
    [409, ExitCode.Refused],
    [426, ExitCode.VersionIncompatible],
    [504, ExitCode.Network],
    [500, ExitCode.Unexpected],
  ])("maps HTTP %i to exit %i", (status, expected) => {
    expect(exitCodeForResponse(status)).toBe(expected);
  });

  it("treats confirmation codes as exit 6 whatever the status", () => {
    expect(exitCodeForResponse(409, "PREVIEW_STALE")).toBe(ExitCode.ConfirmationRequired);
    expect(exitCodeForResponse(422, "ACKNOWLEDGEMENT_REQUIRED")).toBe(
      ExitCode.ConfirmationRequired,
    );
  });

  it("treats the request refusal codes as exit 5 whatever the status", () => {
    // A 403 that is a domain refusal (the person may not withdraw the request), not a missing
    // credential or scope; and the 409 that names the Ticket the request already became.
    expect(exitCodeForResponse(403, "REQUEST_WITHDRAW_FORBIDDEN")).toBe(ExitCode.Refused);
    expect(exitCodeForResponse(409, "REQUEST_ALREADY_CREATED")).toBe(ExitCode.Refused);
    expect(exitCodeForResponse(422, "REQUEST_ALREADY_CREATED")).toBe(ExitCode.Refused);
  });

  it.each([
    "DOMAIN_CYCLE",
    "DOMAIN_TOO_DEEP",
    "DOMAIN_IS_ACCOUNT_ROOT",
    "DOMAIN_COVERAGE_IN_USE",
    "DOMAIN_HAS_OPEN_EPICS",
  ])("treats the domain graph refusal %s as exit 5 whatever the status", (code) => {
    // The server may answer a domain refusal 409 or 422; either way it is a refusal, not a usage
    // error, and a status the CLI does not otherwise map still exits 5.
    for (const status of [400, 403, 404, 409, 422, 500]) {
      expect(exitCodeForResponse(status, code), `${status} ${code}`).toBe(ExitCode.Refused);
    }
  });

  it.each([
    "CONTRACT_LINK_NOT_DELIVERY_ROOT",
    "CONTRACT_LINK_OUTSIDE_PROVIDER",
    "CONTRACT_LINK_OWN_PROVIDER",
    "CONTRACT_LINK_INSIDE_COHORT",
    "CONTRACT_DEPRECATED",
    "CONTRACT_RETIRED",
    "CONTRACT_UNKNOWN_OPERATION",
  ])("treats the contract link refusal %s as exit 5 whatever the status", (code) => {
    // A link the server refuses writes nothing; whether it answers 409 or 422 it is a refusal.
    for (const status of [400, 403, 404, 409, 422, 500]) {
      expect(exitCodeForResponse(status, code), `${status} ${code}`).toBe(ExitCode.Refused);
    }
  });

  it.each([
    "REQUEST_VERSION_CONFLICT",
    "REQUEST_TRANSITION_REFUSED",
    "REQUEST_RATE_LIMITED",
    "REQUEST_SOURCE_PAUSED",
    "REQUEST_BUG_DETAILS_REQUIRED",
    "REQUEST_TARGET_NEEDS_PROJECT",
    "REQUEST_REPLIES_OFF",
  ])("treats the Request refusal %s as exit 5 whatever the status", (code) => {
    // A Request write the server refuses changes nothing: a stale version, a move its state does
    // not allow, a paused or rate-limited source, or a precondition of accept, promote or reply.
    for (const status of [400, 403, 404, 409, 422, 429, 500]) {
      expect(exitCodeForResponse(status, code), `${status} ${code}`).toBe(ExitCode.Refused);
    }
  });

  it("treats REQUEST_NOT_FOUND as exit 4 whatever the status", () => {
    for (const status of [400, 403, 404, 409, 422, 500]) {
      expect(exitCodeForResponse(status, "REQUEST_NOT_FOUND"), `${status}`).toBe(ExitCode.NotFound);
    }
  });

  it("keeps the contract lookups on their status", () => {
    expect(exitCodeForResponse(404, "CONTRACT_NOT_FOUND")).toBe(ExitCode.NotFound);
    expect(exitCodeForResponse(404, "CONTRACT_LINK_NOT_FOUND")).toBe(ExitCode.NotFound);
  });

  it("keeps the domain lookups and the switched-off feature on their status", () => {
    expect(exitCodeForResponse(404, "DOMAIN_NOT_FOUND")).toBe(ExitCode.NotFound);
    expect(exitCodeForResponse(404, "MEMBER_NOT_FOUND")).toBe(ExitCode.NotFound);
    expect(exitCodeForResponse(403, "ENTITLEMENT_LIMIT_REACHED")).toBe(ExitCode.Auth);
    expect(exitCodeForResponse(403, "FEATURE_NOT_IN_PLAN")).toBe(ExitCode.Auth);
  });

  it("keeps other 403 codes as exit 3", () => {
    expect(exitCodeForResponse(403, "FORBIDDEN")).toBe(ExitCode.Auth);
    expect(exitCodeForResponse(403)).toBe(ExitCode.Auth);
  });
});

describe("toCliError", () => {
  it("keeps a CliError", () => {
    const error = new CliError("X", "x", ExitCode.Refused);
    expect(toCliError(error)).toBe(error);
  });

  it("wraps anything else as an internal error", () => {
    const error = toCliError(new Error("boom"));
    expect(error.code).toBe("CLI_INTERNAL");
    expect(error.exitCode).toBe(ExitCode.Unexpected);
  });
});
