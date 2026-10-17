import type { Command } from "commander";
import { usageError } from "../../core/errors.js";
import type { HttpMethod } from "../../core/http.js";
import { inputInvalid, readInput, validateBody, type OpenApiDocument } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import { findPublicOperation, PUBLIC_API_DOCUMENT } from "./document.js";

/**
 * `pidgen api <get|post|put|patch|delete> <path> [--query key=value]... [-f <file|->]`: one request
 * to a route in the public API document, with the selected profile's credential. A path or method
 * the document does not list exits 2 with `PATH_NOT_PUBLIC` and sends nothing; a `-f` body is
 * validated against the operation's request schema before anything is sent. The envelope carries
 * the server's `data`, and server errors keep their own codes.
 */

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];

/**
 * The `api` commands, checking paths against `document`. The registry uses the bundled
 * `contracts/openapi.json`; tests pass another document.
 */
export function apiCommands(document: OpenApiDocument = PUBLIC_API_DOCUMENT): CommandSpec[] {
  return METHODS.map((method) => apiCommand(method, document));
}

function apiCommand(method: Method, document: OpenApiDocument): CommandSpec {
  return {
    path: ["api", method],
    summary: `Send a ${method.toUpperCase()} request to a route in the public API document`,
    configure(command: Command) {
      command
        .argument(
          "<path>",
          "a path in the public API document, e.g. /tickets/PIDGEN-12 (the /api/v1 prefix is optional)",
        )
        .option("--query <key=value>", "add a query parameter; repeat for more", collect, [])
        .option("-f, --file <file>", "request body as JSON or YAML; - reads standard input");
    },
    async run(ctx, { args, options, global }) {
      const target = findPublicOperation(document, method, args[0] ?? "");
      const query = parseQuery(options["query"]);

      let body: unknown;
      const file = options["file"];
      if (typeof file === "string") {
        const input = await readInput(ctx, file);
        body = validateBody(document, method, target.template, input.value);
      } else if (bodyRequired(document, target.operation)) {
        throw inputInvalid(
          `${method.toUpperCase()} ${target.template} requires a request body; give it with -f <file|->`,
          { method: method.toUpperCase(), path: target.template },
        );
      }

      const session = await openSession(ctx, global);
      const response = await session.client.request({
        method: method.toUpperCase() as HttpMethod,
        path: target.path,
        query,
        ...(file !== undefined ? { body } : {}),
      });
      return {
        data: response.data,
        meta: session.meta(response),
        presentation: { responseStatus: response.status },
      };
    },
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `--query key=value` pairs; a key given twice is refused rather than silently dropped. */
function parseQuery(raw: unknown): Record<string, string> {
  const query: Record<string, string> = {};
  for (const pair of Array.isArray(raw) ? (raw as string[]) : []) {
    const at = pair.indexOf("=");
    if (at <= 0) throw usageError(`--query expects key=value, got ${pair}`, { query: pair });
    const key = pair.slice(0, at);
    if (Object.hasOwn(query, key)) {
      throw usageError(`--query ${key} is given more than once`, { query: key });
    }
    query[key] = pair.slice(at + 1);
  }
  return query;
}

/** True when the operation's `requestBody` (following local `$ref`s) is marked required. */
function bodyRequired(document: OpenApiDocument, operation: Record<string, unknown>): boolean {
  let requestBody = operation["requestBody"];
  const seen = new Set<string>();
  while (isRecord(requestBody) && typeof requestBody["$ref"] === "string") {
    const ref = requestBody["$ref"];
    if (seen.has(ref) || !ref.startsWith("#/")) return false;
    seen.add(ref);
    requestBody = ref
      .slice(2)
      .split("/")
      .map((token) => decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((node, token) => (isRecord(node) ? node[token] : undefined), document);
  }
  return isRecord(requestBody) && requestBody["required"] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
