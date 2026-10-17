import { Option } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { components } from "../../generated/api.js";

export type TicketKind = components["schemas"]["TicketKind"];

/** The values of one enum schema in the committed public API document. */
export function documentEnum<T extends string>(schema: string): readonly T[] {
  const schemas = (PUBLIC_API_DOCUMENT as { components?: { schemas?: Record<string, unknown> } })
    .components?.schemas;
  const values = (schemas?.[schema] as { enum?: unknown } | undefined)?.enum;
  if (!Array.isArray(values)) throw new Error(`The public API document has no enum ${schema}.`);
  return values as T[];
}

/** The kinds `--kind` accepts: the document's `TicketKind` (`epic`, `story`, `task`). */
export const TICKET_KINDS = documentEnum<TicketKind>("TicketKind");

/** `--kind <kind>`, limited to the document's kinds; an unknown kind is a usage error. */
export function kindOption(description: string): Option {
  return new Option("--kind <kind>", description).choices(TICKET_KINDS);
}

/** The `--kind` a command was given, if any. */
export function givenKind(options: Record<string, unknown>): TicketKind | undefined {
  return options["kind"] as TicketKind | undefined;
}

/**
 * Refuses a ticket of another kind than `kind` (when one is asked for): `TICKET_KIND_MISMATCH`,
 * exit code 4, since there is no ticket of that kind by the ref. `details` names the ticket, its
 * kind and the kind asked for.
 */
export function requireKind(
  ref: string,
  ticket: { kind?: unknown } | null | undefined,
  kind: TicketKind | undefined,
  requestId?: string | null,
): void {
  if (kind === undefined) return;
  const actual = ticket?.kind;
  if (actual === kind) return;
  const article = (word: string) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
  const what = typeof actual === "string" ? article(actual) : "of no kind";
  throw new CliError(
    "TICKET_KIND_MISMATCH",
    `${ref} is ${what}, not ${article(kind)}.`,
    ExitCode.NotFound,
    {
      ticket: ref,
      kind: typeof actual === "string" ? actual : null,
      expected_kind: kind,
      ...(requestId ? { request_id: requestId } : {}),
    },
  );
}
