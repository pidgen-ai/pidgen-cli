import { createHash } from "node:crypto";
import { CliError, exitCodeForResponse, usageError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import type { ApiClient, ApiResponse, HttpMethod } from "./http.js";

/**
 * The preview → apply engine shared by every command with side effects.
 * See docs/preview-and-apply.md. Commands supply an operation; this module owns the rules.
 */

export interface Preview {
  preview_digest: string;
  required_acknowledgements: string[];
  [key: string]: unknown;
}

export interface ApplyInput {
  preview_digest: string;
  idempotency_key: string;
  acknowledgements: string[];
  reason?: string;
}

/** Outcome of an apply or a status check. `handle` identifies an unsettled operation for polling. */
export interface Outcome {
  settled: boolean;
  result: unknown;
  handle?: string;
}

export interface PreviewApplyOperation {
  /** Command identity, e.g. `ticket retry`; part of the derived idempotency key. */
  command: string;
  /** The resource acted on, e.g. `PIDGEN-12`; part of the derived idempotency key. */
  target: string;
  preview(): Promise<Preview>;
  apply(input: ApplyInput): Promise<Outcome>;
  status(handle: string): Promise<Outcome>;
}

export interface PreviewApplyOptions {
  apply: boolean;
  digest?: string;
  acknowledgements: string[];
  reason?: string;
  idempotencyKey?: string;
  wait: boolean;
  timeoutMs: number;
  pollIntervalMs?: number;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Receives human-readable status while an asynchronous apply is being polled. */
  progress?(message: string): void;
}

export type PreviewApplyResult =
  | { mode: "preview"; preview: Preview }
  | { mode: "apply"; settled: boolean; result: unknown; handle?: string; idempotency_key: string };

export async function runPreviewApply(
  operation: PreviewApplyOperation,
  options: PreviewApplyOptions,
): Promise<PreviewApplyResult> {
  const acknowledgements = normalizeAcknowledgements(options.acknowledgements);

  if (!options.apply) {
    if (options.digest !== undefined) throw usageError("--digest is only meaningful with --apply.");
    return { mode: "preview", preview: await operation.preview() };
  }

  let digest = options.digest;
  if (digest === undefined) {
    const preview = await operation.preview();
    if (preview.required_acknowledgements.length > 0) {
      throw new CliError(
        "DIGEST_REQUIRED",
        "This change needs acknowledgements. Review the preview, then apply it with --digest and --ack.",
        ExitCode.ConfirmationRequired,
        { preview },
      );
    }
    digest = preview.preview_digest;
  }

  const idempotencyKey =
    options.idempotencyKey ?? deriveIdempotencyKey(operation, digest, acknowledgements);
  let outcome = await withGuidance(() =>
    operation.apply({
      preview_digest: digest,
      idempotency_key: idempotencyKey,
      acknowledgements,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    }),
  );

  if (!outcome.settled && options.wait) {
    if (outcome.handle === undefined) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        "The server accepted the change but returned nothing to follow it with.",
        ExitCode.Unexpected,
      );
    }
    const handle = outcome.handle;
    outcome = await withGuidance(() => waitForSettled(operation, handle, options));
  }

  return {
    mode: "apply",
    settled: outcome.settled,
    result: outcome.result,
    ...(outcome.handle !== undefined ? { handle: outcome.handle } : {}),
    idempotency_key: idempotencyKey,
  };
}

/** Acknowledgement codes are accepted as `ambiguous-effects` or `ambiguous_effects` and sent snake_case. */
export function normalizeAcknowledgements(codes: string[]): string[] {
  const normalized = codes.map((code) => code.trim().toLowerCase().replaceAll("-", "_"));
  for (const code of normalized) {
    if (!/^[a-z][a-z0-9_]*$/.test(code)) throw usageError(`Not an acknowledgement code: "${code}"`);
  }
  return [...new Set(normalized)].sort();
}

/** Same command, target, digest and acknowledgements → same key, so a repeated apply is safe. */
export function deriveIdempotencyKey(
  operation: Pick<PreviewApplyOperation, "command" | "target">,
  digest: string,
  acknowledgements: string[],
): string {
  const hash = createHash("sha256")
    .update([operation.command, operation.target, digest, ...acknowledgements].join("\n"))
    .digest("hex");
  return `pidgen-${hash.slice(0, 32)}`;
}

async function waitForSettled(
  operation: PreviewApplyOperation,
  handle: string,
  options: PreviewApplyOptions,
): Promise<Outcome> {
  const deadline = options.now() + options.timeoutMs;
  const interval = options.pollIntervalMs ?? 2000;
  for (;;) {
    options.progress?.(`Waiting for operation ${handle} to settle...`);
    await options.sleep(interval);
    const outcome = await operation.status(handle);
    if (outcome.settled) return outcome;
    if (options.now() >= deadline) {
      throw new CliError(
        "TIMEOUT",
        "The change is still in progress on the server. Check it later; it was not cancelled.",
        ExitCode.Network,
        { handle, last: outcome.result },
      );
    }
  }
}

/**
 * A stale preview or a missing acknowledgement exits 6 and says what to do next. The CLI never
 * acknowledges on the caller's behalf: it names the missing codes and leaves passing them to the
 * caller. Every other error — including the server's other refusals, which exit 5 — passes through
 * with the server's code.
 */
async function withGuidance<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw confirmationGuidance(error);
  }
}

export function confirmationGuidance(error: unknown): unknown {
  if (!(error instanceof CliError)) return error;
  let next: string;
  if (error.code === "PREVIEW_STALE") {
    next =
      "Preview again (run the command without --apply) and apply the new preview_digest with --digest.";
  } else if (error.code === "ACKNOWLEDGEMENT_REQUIRED") {
    const missing = stringList(error.details["missing"]);
    next =
      missing.length > 0
        ? `Review the preview; to accept, apply again with ${missing.map((code) => `--ack ${code}`).join(" ")}.`
        : "Review the preview's required_acknowledgements; to accept, apply again with --ack for each.";
  } else if (error.code === "DIGEST_REQUIRED") {
    next = "Preview first, then apply with --digest and the preview_digest it printed.";
  } else {
    return error;
  }
  return new CliError(
    error.code,
    `${error.message.replace(/\s*$/, "")} ${next}`.trim(),
    ExitCode.ConfirmationRequired,
    { ...error.details, next },
  );
}

/** A request to one of the server's preview or apply routes. */
export interface ServerRoute {
  /** Defaults to POST. */
  method?: HttpMethod;
  /** Path under `/api/v1`, e.g. `/tickets/PIDGEN-4/reopen/preview`. */
  path: string;
  /** Route-specific fields, e.g. the `plan` a child-plan preview checks and its apply sends back. */
  body?: Record<string, unknown>;
}

export interface ServerPreviewApplyRoutes {
  command: string;
  target: string;
  preview: ServerRoute;
  apply: ServerRoute;
}

/**
 * Builds the operation for a published preview/apply pair on the server's single convention:
 * the preview answers `preview_digest` and `required_acknowledgements`; the apply takes
 * `preview_digest`, `idempotency_key`, `acknowledgements` and `reason` beside its own fields, and
 * answers 200 when settled or 202 with `status_url` while applying; the status route answers 200
 * once settled, 202 until then, or the refusal as an error. See docs/preview-and-apply.md.
 */
export function serverPreviewApply(
  api: Pick<ApiClient, "request">,
  routes: ServerPreviewApplyRoutes,
): PreviewApplyOperation {
  return {
    command: routes.command,
    target: routes.target,
    async preview() {
      const response = await api.request({
        method: routes.preview.method ?? "POST",
        path: routes.preview.path,
        ...(routes.preview.body !== undefined ? { body: routes.preview.body } : {}),
      });
      return readPreview(response);
    },
    async apply(input) {
      const response = await api.request({
        method: routes.apply.method ?? "POST",
        path: routes.apply.path,
        body: { ...routes.apply.body, ...input },
        idempotent: true,
      });
      return readOutcome(response);
    },
    async status(handle) {
      const response = await api.request({ method: "GET", path: handle });
      const outcome = readOutcome(response);
      return outcome.handle === undefined && !outcome.settled ? { ...outcome, handle } : outcome;
    },
  };
}

function readPreview(response: ApiResponse): Preview {
  const data = response.data;
  const refusal = answeredRefusal(response);
  if (refusal !== null) throw refusal;
  if (
    isRecord(data) &&
    typeof data["preview_digest"] === "string" &&
    data["preview_digest"] !== "" &&
    Array.isArray(data["required_acknowledgements"]) &&
    data["required_acknowledgements"].every((code) => typeof code === "string")
  ) {
    return data as Preview;
  }
  throw new CliError(
    "UNEXPECTED_RESPONSE",
    "The server's preview did not carry a preview_digest and required_acknowledgements.",
    ExitCode.Unexpected,
  );
}

/**
 * 202, or a body whose `status` is `applying`, is unsettled; its `status_url` is polled. A settled
 * result's `status_url` is left as the server gave it.
 */
function readOutcome(response: ApiResponse): Outcome {
  const data = response.data;
  const refusal = answeredRefusal(response);
  if (refusal !== null) throw refusal;
  const applying = response.status === 202 || (isRecord(data) && data["status"] === "applying");
  const statusUrl = isRecord(data) ? data["status_url"] : undefined;
  // Only an unsettled outcome is followed, so a settled one's status_url is never parsed.
  const handle =
    applying && typeof statusUrl === "string" && statusUrl !== ""
      ? statusPath(statusUrl)
      : undefined;
  return {
    settled: !applying,
    result: data,
    ...(applying && handle !== undefined ? { handle } : {}),
  };
}

/**
 * A refusal the server answered as a success. Some routes record a refused command durably and
 * answer it with `200`: its result's `status` is `refused` (or `rejected`), or its `disposition` is
 * `refused`, or it names a `disposition_code` without being `applied` or `applying`. Nothing was
 * applied, so it is reported like any other refusal: `disposition_code` becomes `error.code` and it
 * exits 5 — or 6 for `PREVIEW_STALE` and `ACKNOWLEDGEMENT_REQUIRED`, which then say what to do next.
 */
export function answeredRefusal(response: ApiResponse): CliError | null {
  const data = response.data;
  if (!isRecord(data)) return null;
  const status = data["status"];
  const dispositionCode =
    typeof data["disposition_code"] === "string" && data["disposition_code"] !== ""
      ? data["disposition_code"]
      : undefined;
  const refused =
    status === "refused" ||
    status === "rejected" ||
    data["disposition"] === "refused" ||
    (dispositionCode !== undefined && status !== "applied" && status !== "applying");
  if (!refused) return null;
  const code =
    dispositionCode ??
    (typeof data["code"] === "string" && data["code"] !== "" ? data["code"] : "REFUSED");
  const detail = data["disposition_detail"];
  const message =
    typeof detail === "string" && detail !== ""
      ? detail
      : typeof data["message"] === "string" && data["message"] !== ""
        ? data["message"]
        : `The server refused the change with ${code}; nothing was applied.`;
  return new CliError(code, message, exitCodeForResponse(409, code), {
    status: response.status,
    request_id: response.requestId,
    disposition_code: code,
    ...(detail !== undefined ? { disposition_detail: detail } : {}),
    result: data,
  });
}

/**
 * The status route is always read from the configured server: an absolute `status_url` contributes
 * only its path and query, so the credential is never sent to another origin.
 */
function statusPath(statusUrl: string): string {
  if (statusUrl.startsWith("/")) return statusUrl;
  try {
    const url = new URL(statusUrl);
    return url.pathname + url.search;
  } catch {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server returned a status_url that is not a URL: "${statusUrl}".`,
      ExitCode.Unexpected,
    );
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
