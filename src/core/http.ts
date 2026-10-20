import { CliError, defaultCodeForStatus, exitCodeForResponse } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import { API_VERSION, CLI_VERSION } from "./version.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequest {
  method: HttpMethod;
  /** Path under `/api/v1`, e.g. `/tickets/PIDGEN-12`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * A multipart body (a staged upload), sent as it is instead of `body`; fetch sets its content
   * type with the boundary.
   */
  form?: FormData;
  /** Retry on network failure even though the method is not GET. Set for requests carrying an idempotency key. */
  idempotent?: boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
  requestId: string | null;
  apiVersion: string | null;
  /** The success body's own `meta`, when it has one (e.g. what a ticket edit did to admission). */
  meta?: unknown;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string | null;
  account: string | null;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  timeoutMs: number;
  maxAttempts?: number;
}

const API_PREFIX = "/api/v1";

/** The only way the CLI talks to Pidgen. See docs/api-compatibility.md. */
export class ApiClient {
  private readonly options: ApiClientOptions;

  constructor(options: ApiClientOptions) {
    this.options = options;
  }

  async request<T = unknown>(request: ApiRequest): Promise<ApiResponse<T>> {
    return this.parse<T>(await this.send(request, "application/json"));
  }

  /**
   * Sends `request` for a file, such as an archive, answered in `accept` (e.g. `application/gzip`)
   * instead of JSON: `data` is the body's bytes, unread. A refusal is read from its JSON body as
   * `request` reads it.
   */
  async download(request: ApiRequest, accept: string): Promise<ApiResponse<Uint8Array>> {
    const response = await this.send(request, `${accept}, application/json`);
    if (!response.ok) return this.parse<never>(response);
    return {
      status: response.status,
      data: new Uint8Array(await response.arrayBuffer()),
      requestId: response.headers.get("x-request-id"),
      apiVersion: response.headers.get("pidgen-api-version"),
    };
  }

  private async send(request: ApiRequest, accept: string): Promise<Response> {
    const url = this.url(request);
    const retryable = request.method === "GET" || request.idempotent === true;
    const attempts = retryable ? (this.options.maxAttempts ?? 3) : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.options.fetch(url, {
          method: request.method,
          headers: this.headers(request.form === undefined && request.body !== undefined, accept),
          ...(request.form !== undefined
            ? { body: request.form }
            : request.body !== undefined
              ? { body: JSON.stringify(request.body) }
              : {}),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await this.options.sleep(250 * 2 ** (attempt - 1));
      }
    }
    throw networkError(lastError, url);
  }

  private url(request: ApiRequest): string {
    const path = request.path.startsWith(API_PREFIX) ? request.path : API_PREFIX + request.path;
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(hasJsonBody: boolean, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept,
      "pidgen-api-version": API_VERSION,
      "user-agent": `pidgen/${CLI_VERSION} node/${process.versions.node}`,
    };
    if (hasJsonBody) headers["content-type"] = "application/json";
    if (this.options.token) headers["authorization"] = `Bearer ${this.options.token}`;
    if (this.options.account) headers["x-pidgen-account"] = this.options.account;
    return headers;
  }

  private async parse<T>(response: Response): Promise<ApiResponse<T>> {
    const requestId = response.headers.get("x-request-id");
    const apiVersion = response.headers.get("pidgen-api-version");
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new CliError(
          "UNEXPECTED_RESPONSE",
          `The server returned non-JSON content (HTTP ${response.status}).`,
          ExitCode.Unexpected,
          { status: response.status, request_id: requestId },
        );
      }
    }
    if (!response.ok) throw serverError(response.status, body, requestId);
    const result: ApiResponse<T> = {
      status: response.status,
      data: unwrap(body) as T,
      requestId,
      apiVersion,
    };
    if (isRecord(body) && body["status"] === "ok" && "meta" in body) result.meta = body["meta"];
    return result;
  }
}

/** Successful bodies are `{"status": "ok", "data": …}`; anything else is passed through. */
function unwrap(body: unknown): unknown {
  if (isRecord(body) && body["status"] === "ok" && "data" in body) return body["data"];
  return body;
}

/**
 * Published routes answer errors in the public shape
 * `{"status": "error", "error": {"code", "message", "details", "request_id"}}`. Anything else is read
 * as `{"detail": {"code", "message", …}}`, a plain `detail` string, or a validation list.
 * See docs/output-and-exit-codes.md.
 */
function serverError(status: number, body: unknown, requestId: string | null): CliError {
  if (isRecord(body) && body["status"] === "error" && isRecord(body["error"])) {
    return publicError(status, body["error"], requestId);
  }
  const detail = isRecord(body) ? body["detail"] : undefined;
  let code: string | undefined;
  let message = `HTTP ${status}`;
  const details: Record<string, unknown> = { status, request_id: requestId };
  if (isRecord(detail)) {
    if (typeof detail["code"] === "string") code = detail["code"];
    if (typeof detail["message"] === "string") message = detail["message"];
    for (const [key, value] of Object.entries(detail)) {
      if (key !== "code" && key !== "message") details[key] = value;
    }
  } else if (typeof detail === "string") {
    message = detail;
  } else if (Array.isArray(detail)) {
    message = "The request did not match the API schema.";
    details["issues"] = detail;
  }
  return new CliError(
    code ?? defaultCodeForStatus(status),
    message,
    exitCodeForResponse(status, code),
    details,
  );
}

/**
 * Reads the public error shape. `error.code` becomes the envelope's `error.code` and drives the exit
 * code; `error.details` (for example `errors` on `INPUT_INVALID`) and `error.request_id` are carried
 * into the envelope's `error.details` next to the HTTP status.
 */
function publicError(
  status: number,
  error: Record<string, unknown>,
  headerRequestId: string | null,
): CliError {
  const code = typeof error["code"] === "string" && error["code"] ? error["code"] : undefined;
  const message =
    typeof error["message"] === "string" && error["message"] ? error["message"] : `HTTP ${status}`;
  const requestId = typeof error["request_id"] === "string" ? error["request_id"] : headerRequestId;
  const details: Record<string, unknown> = { status, request_id: requestId };
  const serverDetails = error["details"];
  if (isRecord(serverDetails)) {
    for (const [key, value] of Object.entries(serverDetails)) {
      if (key !== "status" && key !== "request_id") details[key] = value;
    }
  } else if (serverDetails !== undefined && serverDetails !== null) {
    details["details"] = serverDetails;
  }
  return new CliError(
    code ?? defaultCodeForStatus(status),
    message,
    exitCodeForResponse(status, code),
    details,
  );
}

function networkError(error: unknown, url: string): CliError {
  const timedOut =
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  return new CliError(
    timedOut ? "TIMEOUT" : "NETWORK",
    timedOut
      ? `No response from ${new URL(url).origin} in time.`
      : `Could not reach ${new URL(url).origin}.`,
    ExitCode.Network,
    { cause: error instanceof Error ? error.message : String(error) },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
