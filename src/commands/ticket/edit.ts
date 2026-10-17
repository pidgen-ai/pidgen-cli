import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { inputInvalid, readInput, validateBody } from "../../core/input.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { pathSegment } from "../../core/read.js";
import type { CommandResult, CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";
import { givenKind, kindOption, requireKind, type TicketKind } from "./kind.js";

type TicketDetail = components["schemas"]["TicketDetailResource"];
type TicketRecord = components["schemas"]["TicketRecord"];
type TicketEditMeta = components["schemas"]["TicketEditMeta"];

/** The operation `ticket edit` sends, as the public API document names it. */
export const EDIT_ROUTE = { method: "patch", path: "/tickets/{ticket_id}" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `pidgen ticket edit <ref> -f <file>`: edits a ticket's content (`PATCH /tickets/{ref}`). The file
 * holds only the fields to change, the `title` and `team_member_id` (the Agent to reassign the
 * ticket to, an Account Agent ID of 1-80 characters; null is refused) among them; the CLI reads the ticket
 * (`GET /tickets/{ref}`) and sends its current `version` with them, so the edit is fenced by what
 * the server holds now. `success_metrics`, `context_artifacts` and `required_capabilities` are
 * optional whole-list replacements, accepting arrays or null with the same items as creation.
 * The file is validated against `EditTicketRequest` before anything is sent:
 * a body that does not parse or match, names no field, names `version` itself, or gives a `title`
 * that is empty after trimming is `INPUT_INVALID` (exit code 2); the title is sent as written. A
 * ticket that changed between the read and the edit is the server's `CONFLICT` (exit code 5), as
 * are `EDIT_STAGE_NOT_ALLOWED` and `EDIT_MERGE_POLICY_LOCKED`, whose `error.details` the server
 * fills with the refused `field` (and the ticket's `stage`). The Agent's eligibility is the server's
 * to judge: `TEAM_MEMBER_NOT_FOUND` (exit code 4), `TEAM_MEMBER_ARCHIVED` (422, exit code 2) and an
 * assignment refusal (409, exit code 5) are reported with their codes. `data` is the ticket as the edit left
 * it, with `admission`: the server's `meta`, the report of what the edit did to the root's
 * execution admission and planning (`planning_restarted` among it), or `null` when untouched.
 * With `--kind` (e.g. `--kind epic`), a ticket of another kind is `TICKET_KIND_MISMATCH` (exit
 * code 4) and no edit is sent. `parent_ticket_id` moves a Story or Task into an Epic, or out of
 * it with `null` (see `pidgen ticket move`).
 */
export const ticketEdit: CommandSpec = {
  path: ["ticket", "edit"],
  summary: "Edit a ticket's content from a JSON or YAML file",
  configure(command: Command) {
    command
      .argument("<ref>", "the ticket's key, e.g. PIDGEN-12, or its id")
      .requiredOption(
        "-f, --file <file>",
        "the fields to change as JSON or YAML; - reads standard input",
      )
      .addOption(kindOption("refuse the edit unless the ticket is of this kind, e.g. epic"))
      .addHelpText(
        "after",
        "\nReadiness fields: success_metrics, context_artifacts and required_capabilities are " +
          "optional whole-list replacements (arrays or null). Metrics require name and target " +
          "(current and unit are optional); artifacts require type and content " +
          "(reference_url and tier are optional); capabilities are strings. " +
          "Omitted fields stay unchanged. The CLI fetches version; omit it from the file.",
      );
  },
  async run(ctx, { args, options, global }) {
    return editTicket(ctx, global, args[0], String(options["file"]), givenKind(options));
  },
};

/**
 * Edits the ticket `rawRef` names with the fields of the file `source` names: reads the ticket
 * (`GET /tickets/{ref}`) for its `version`, then sends `PATCH /tickets/{ref}`. With `kind`, a
 * ticket of another kind is `TICKET_KIND_MISMATCH` (exit code 4) and nothing is changed.
 */
export async function editTicket(
  ctx: RunContext,
  global: GlobalOptions,
  rawRef: string | undefined,
  source: string,
  kind?: TicketKind,
): Promise<CommandResult> {
  const ref = pathSegment("ticket ref", rawRef);
  const input = await readInput(ctx, source);
  const changes = editChanges(input.value);

  const session = await openSession(ctx, global);
  const current = await session.client.request<TicketDetail>({
    method: "GET",
    path: `/tickets/${ref}`,
  });
  requireKind(String(rawRef).trim(), current.data, kind, current.requestId);
  const version = current.data?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's ticket ${String(rawRef).trim()} has no version to edit against.`,
      ExitCode.Unexpected,
      { request_id: current.requestId },
    );
  }

  const response = await session.client.request<TicketRecord>({
    method: "PATCH",
    path: `/tickets/${ref}`,
    body: { version, ...changes },
  });
  const admission = (response.meta ?? null) as TicketEditMeta | null;
  return { data: { ...response.data, admission }, meta: session.meta(response) };
}

/**
 * The fields to change, checked against the edit schema with a placeholder version. The file
 * never carries `version`: the CLI reads it from the ticket.
 */
function editChanges(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    validateBody(PUBLIC_API_DOCUMENT, EDIT_ROUTE.method, EDIT_ROUTE.path, value);
    throw inputInvalid("The edit file must be an object of fields to change.");
  }
  if (Object.hasOwn(value, "version")) {
    throw inputInvalid(
      "The edit file must not name version: the CLI sends the ticket's current version.",
      { issues: [{ path: "$.version", message: "Remove version; it is read from the ticket." }] },
    );
  }
  if (Object.keys(value).length === 0) {
    throw inputInvalid("The edit file names no field to change.", {
      issues: [{ path: "$", message: "Name at least one field to change." }],
    });
  }
  validateBody(PUBLIC_API_DOCUMENT, EDIT_ROUTE.method, EDIT_ROUTE.path, { version: 0, ...value });
  // The schema's minimum length counts spaces; the contract asks for a title that is non-empty
  // once trimmed, which the server would refuse after a round trip.
  if (typeof value["title"] === "string" && value["title"].trim() === "") {
    throw inputInvalid("The edit file's title must not be empty.", {
      issues: [
        { path: "$.title", message: "Give a title with at least one character besides spaces." },
      ],
    });
  }
  return value;
}
