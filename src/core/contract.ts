import { createHash } from "node:crypto";
import { loadConfig, resolveTarget } from "./config.js";
import type { GlobalOptions, RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { anonymousClient } from "./session.js";

/** Where the App Service serves its public API document, under `/api/v1`. */
export const CONTRACT_PATH = "/openapi.json";

/** One public API document, as far as the comparison reads it. */
export interface ContractSummary {
  /** The document's `info.version`, or null when it has none. */
  version: string | null;
  /** `sha256:` and the hex digest of the document with its object keys sorted. */
  digest: string;
}

/** How the CLI's committed contract compares with the configured server's published one. */
export interface ContractReport {
  /** `same` when the digests match, `different` when they do not, `unchecked` when no server document was read. */
  state: "same" | "different" | "unchecked";
  cli: ContractSummary;
  server: ContractSummary | null;
  /** Operations (`METHOD /path`) the CLI's contract has and the server's does not. */
  only_in_cli: string[];
  /** Operations the server's contract has and the CLI's does not. */
  only_on_server: string[];
  /** Why the server's document was not read, or null when it was. */
  reason: { code: string; message: string } | null;
}

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value with every object's keys sorted, so key order and formatting never count. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** The digest of a document's content: equal for documents that differ only in key order or whitespace. */
export function contractDigest(document: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical(document)))
    .digest("hex");
  return `sha256:${hash}`;
}

export function summarizeContract(document: unknown): ContractSummary {
  const info = isRecord(document) ? document["info"] : undefined;
  const version = isRecord(info) && typeof info["version"] === "string" ? info["version"] : null;
  return { version, digest: contractDigest(document) };
}

/** Every operation of a document as `METHOD /path`, sorted. */
function operations(document: unknown): string[] {
  const paths = isRecord(document) ? document["paths"] : undefined;
  if (!isRecord(paths)) return [];
  const result: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of Object.keys(item)) {
      if (METHODS.has(method)) result.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return result.sort();
}

/** Compares the CLI's committed document with a server's. */
export function compareContracts(cli: unknown, server: unknown): ContractReport {
  const local = summarizeContract(cli);
  const remote = summarizeContract(server);
  const ours = operations(cli);
  const theirs = operations(server);
  const same = local.digest === remote.digest && local.version === remote.version;
  return {
    state: same ? "same" : "different",
    cli: local,
    server: remote,
    only_in_cli: ours.filter((operation) => !theirs.includes(operation)),
    only_on_server: theirs.filter((operation) => !ours.includes(operation)),
    reason: null,
  };
}

/** A report for a server document that could not be read. */
export function uncheckedContract(cli: unknown, code: string, message: string): ContractReport {
  return {
    state: "unchecked",
    cli: summarizeContract(cli),
    server: null,
    only_in_cli: [],
    only_on_server: [],
    reason: { code, message },
  };
}

/**
 * Reads the configured server's public API document (`GET /api/v1/openapi.json`, sent without a
 * credential or Account) and compares it with `cli`. Never throws: a missing server, a network
 * failure, a refusal or a body that is not an API document is an `unchecked` report saying why.
 */
export async function checkContract(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
  cli: unknown,
): Promise<ContractReport> {
  try {
    const config = await loadConfig(ctx);
    const target = resolveTarget(ctx, config, global);
    const client = anonymousClient(ctx, target.url, global);
    const { data } = await client.request<unknown>({ method: "GET", path: CONTRACT_PATH });
    if (!isRecord(data) || typeof data["openapi"] !== "string" || !isRecord(data["paths"])) {
      return uncheckedContract(
        cli,
        "UNEXPECTED_RESPONSE",
        "The server's /api/v1/openapi.json is not an OpenAPI document.",
      );
    }
    return compareContracts(cli, data);
  } catch (error) {
    if (error instanceof CliError) return uncheckedContract(cli, error.code, error.message);
    return uncheckedContract(cli, "CLI_INTERNAL", String(error));
  }
}
