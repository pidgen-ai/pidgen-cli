import bundled from "../../../contracts/openapi.json" with { type: "json" };
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { OpenApiDocument } from "../../core/input.js";

/**
 * The public API document `pidgen api` checks paths against: the committed
 * `contracts/openapi.json`, bundled into the CLI at build time.
 */
export const PUBLIC_API_DOCUMENT: OpenApiDocument = bundled;

export const API_PREFIX = "/api/v1";

/** A request path matched to an operation in the public API document. */
export interface PublicOperation {
  /** The operation's path template exactly as the document lists it, e.g. `/api/v1/tickets/{ref}`. */
  template: string;
  /** The concrete path to request, always with the `/api/v1` prefix, e.g. `/api/v1/tickets/PIDGEN-12`. */
  path: string;
  /** The operation object from the document. */
  operation: Record<string, unknown>;
}

export function pathNotPublic(
  method: string,
  path: string,
  details: Record<string, unknown> = {},
): CliError {
  return new CliError(
    "PATH_NOT_PUBLIC",
    `${method.toUpperCase()} ${path} is not in the public API document`,
    ExitCode.Usage,
    { method: method.toUpperCase(), path, ...details },
  );
}

/**
 * Finds the operation for `method path` in `document`. `path` is a concrete path such as
 * `/tickets/PIDGEN-12`, with or without the `/api/v1` prefix; the document's templates may be
 * written either way too. When several templates match, the one with the most literal segments
 * wins, so `/tickets/template` beats `/tickets/{ref}`. Fails with `PATH_NOT_PUBLIC` (exit code 2)
 * when no template has that method, and with `CLI_USAGE` for a path carrying a query string.
 */
export function findPublicOperation(
  document: OpenApiDocument,
  method: string,
  path: string,
): PublicOperation {
  const verb = method.toLowerCase();
  if (/[?#]/.test(path)) {
    throw usageError("Give query parameters with --query key=value, not in the path.", {
      path,
    });
  }
  const given = withoutPrefix(path.startsWith("/") ? path : `/${path}`);
  if (given === null) throw pathNotPublic(method, path);
  const segments = given.split("/");

  let best: { template: string; operation: Record<string, unknown>; literals: number } | null =
    null;
  const allowed = new Set<string>();
  for (const [template, item] of Object.entries(document.paths ?? {})) {
    const pattern = withoutPrefix(template);
    if (pattern === null || !isRecord(item)) continue;
    const literals = matchSegments(pattern.split("/"), segments);
    if (literals === null) continue;
    for (const key of Object.keys(item)) {
      if (HTTP_METHODS.has(key) && isRecord(item[key])) allowed.add(key.toUpperCase());
    }
    const operation = item[verb];
    if (isRecord(operation) && (best === null || literals > best.literals)) {
      best = { template, operation, literals };
    }
  }
  if (best === null) {
    throw pathNotPublic(method, path, allowed.size > 0 ? { allowed_methods: [...allowed] } : {});
  }
  return { template: best.template, path: `${API_PREFIX}${given}`, operation: best.operation };
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * `path` without the `/api/v1` prefix, or null when it cannot be a public path: a segment that is
 * a dot segment, or that holds a slash or backslash once percent-decoded, would let the request
 * reach a route other than the one matched.
 */
function withoutPrefix(path: string): string | null {
  let rest = path;
  if (rest === API_PREFIX) rest = "/";
  else if (rest.startsWith(`${API_PREFIX}/`)) rest = rest.slice(API_PREFIX.length);
  for (const segment of rest.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    const control = [...decoded].some((char) => char.charCodeAt(0) < 0x20);
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded) || control) return null;
  }
  return rest;
}

/**
 * Matches concrete path segments against template segments (`{name}` matches any non-empty text
 * within one segment). Returns the number of literal template segments, or null for no match.
 */
function matchSegments(template: string[], given: string[]): number | null {
  if (template.length !== given.length) return null;
  let literals = 0;
  for (const [index, part] of template.entries()) {
    const value = given[index] as string;
    if (!part.includes("{")) {
      if (part !== value) return null;
      literals++;
      continue;
    }
    const source = part
      .split(/(\{[^}]*\})/)
      .map((piece) => (/^\{[^}]*\}$/.test(piece) ? "[^/]+" : escapeRegExp(piece)))
      .join("");
    if (!new RegExp(`^${source}$`).test(value)) return null;
  }
  return literals;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
