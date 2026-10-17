import { renderHuman, type PresentationContext } from "./human.js";
import { renderDetails } from "./resource-human.js";
import { renderMutationFailure } from "./mutation-human.js";
import type { CliError } from "./errors.js";
import { CLI_VERSION } from "./version.js";

/** The single JSON document every command prints. See docs/output-and-exit-codes.md. */
export interface Envelope {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Meta;
}

export interface Meta {
  request_id: string | null;
  api_version: string | null;
  profile: string | null;
  account: string | null;
  cli_version: string;
}

export type OutputFormat = "json" | "table";

export function emptyMeta(): Meta {
  return {
    request_id: null,
    api_version: null,
    profile: null,
    account: null,
    cli_version: CLI_VERSION,
  };
}

export function success(data: unknown, meta: Meta): Envelope {
  return { ok: true, data: data ?? null, error: null, meta };
}

export function failure(error: CliError, meta: Meta): Envelope {
  return {
    ok: false,
    data: null,
    error: { code: error.code, message: error.message, details: error.details },
    meta,
  };
}

export function render(
  envelope: Envelope,
  format: OutputFormat,
  context: PresentationContext = {},
): string {
  if (format === "json") return JSON.stringify(envelope) + "\n";
  if (!envelope.ok && envelope.error) {
    const mutation = renderMutationFailure(
      context.command?.join(" ") ?? "",
      envelope.error,
      context.terminal?.columns,
    );
    if (mutation !== undefined) return mutation;
    const details =
      Object.keys(envelope.error.details).length > 0
        ? `Details:\n${renderDetails(envelope.error.details, context.terminal?.columns)}\n`
        : "";
    return `error ${envelope.error.code}: ${envelope.error.message}\n${details}`;
  }
  return renderHuman(envelope.data, context);
}

/** Human rendering. Not a contract: scripts must explicitly select JSON. */
export function renderTable(data: unknown): string {
  return renderHuman(data);
}
