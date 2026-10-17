import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { DOMAIN_EPIC_REFUSED_FIELDS } from "../../core/domain-epics.js";
import { optionalText } from "../../core/domains.js";
import { inputInvalid, readInput, validateBody, type InputIssue } from "../../core/input.js";
import type { CommandResult, CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";
import { givenKind, kindOption, type TicketKind } from "./kind.js";

type CreatedTicket = components["schemas"]["CreatedTicket"];

/** The operation `ticket create` sends, as the public API document names it. */
export const CREATE_ROUTE = { method: "post", path: "/tickets" } as const;

/**
 * Creates a ticket from the file `source` names (`-` reads standard input) with `POST /tickets`.
 * With `kind`, the body's `kind` is set to it; a file that names another kind is `INPUT_INVALID`.
 *
 * With `domain`, the ticket is a Domain Epic: the body is sent with `kind: epic` and `domain_id`
 * set to the domain instead of a `project_id`, and validated against the published request, which
 * carries `domain_id`. Another `kind`, or a file that names
 * `project_id`, `branch_mode`, `feature_branch`, another kind or another `domain_id`, is
 * `INPUT_INVALID` and nothing is sent. Without `domain` nothing changes.
 */
export async function createTicket(
  ctx: RunContext,
  global: GlobalOptions,
  source: string,
  kind?: TicketKind,
  domain?: string,
): Promise<CommandResult> {
  if (domain !== undefined && kind !== undefined && kind !== "epic") {
    throw inputInvalid(`--domain files a Domain Epic, which is not a ${kind}.`, {
      option: "--kind",
      value: kind,
    });
  }
  const asked = domain !== undefined ? "epic" : kind;
  const flag = domain !== undefined ? "--domain" : "--kind";
  const input = await readInput(ctx, source);
  let value = input.value;
  if (asked !== undefined && isRecord(value)) {
    if (value["kind"] !== undefined && value["kind"] !== asked) {
      throw inputInvalid(`The file's kind is not ${asked}, which ${flag} asks for.`, {
        method: "POST",
        path: CREATE_ROUTE.path,
        issues: [{ path: "$.kind", message: `Remove kind, or set it to ${asked}.` }],
      });
    }
    value = { ...value, kind: asked };
  }
  if (domain !== undefined && isRecord(value)) value = domainEpicBody(value, domain);
  const body = validateBody(PUBLIC_API_DOCUMENT, CREATE_ROUTE.method, CREATE_ROUTE.path, value);
  const session = await openSession(ctx, global);
  const response = await session.client.request<CreatedTicket>({
    method: "POST",
    path: CREATE_ROUTE.path,
    body,
  });
  return { data: response.data, meta: session.meta(response) };
}

/**
 * A Domain Epic's body: the file's fields with `domain_id` set to `domain`. A file that names a
 * field the domain stands in for (`project_id`, `branch_mode`, `feature_branch`, even as null), or
 * another `domain_id`, is `INPUT_INVALID` naming every such field.
 */
function domainEpicBody(value: Record<string, unknown>, domain: string): Record<string, unknown> {
  const issues: InputIssue[] = DOMAIN_EPIC_REFUSED_FIELDS.filter((field) =>
    Object.hasOwn(value, field),
  ).map((field) => ({
    path: `$.${field}`,
    message: `Remove ${field}: a Domain Epic is filed in the domain's home and owns no branch.`,
  }));
  if (Object.hasOwn(value, "domain_id") && value["domain_id"] !== domain) {
    issues.push({
      path: "$.domain_id",
      message: `Remove domain_id, or set it to ${domain}, which --domain names.`,
    });
  }
  if (issues.length > 0) {
    const fields = issues.map((issue) => issue.path.slice(2)).join(", ");
    throw inputInvalid(`A Domain Epic's file may not name ${fields}.`, {
      method: "POST",
      path: CREATE_ROUTE.path,
      issues,
    });
  }
  return { ...value, domain_id: domain };
}

/** The `--domain <domain>` option of the commands that file an Epic. */
export const DOMAIN_OPTION = [
  "--domain <domain>",
  "file a Domain Epic in this domain (its key, e.g. PAY, or its id) instead of a project",
] as const;

/** The `--domain` a command was given, trimmed; given empty, it is a usage error (exit 2). */
export function givenDomain(options: Record<string, unknown>): string | undefined {
  return optionalText(options, "domain");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `pidgen ticket create -f <file> [--kind <kind>]`: creates a ticket in Backlog (`POST /tickets`)
 * from a JSON or YAML file, or standard input with `-f -`. `--kind epic` files an Epic: the body
 * is sent with `kind: epic`, and may carry an Epic's `description`, `branch_mode`,
 * `feature_branch` and `target_date`. A Story or Task is placed in an Epic by its
 * `parent_ticket_id`. The body is validated against `CreateTicketRequest` in the public API
 * document before anything is sent and is otherwise sent as written; a body that does not parse
 * or match, or names another kind than `--kind`, is `INPUT_INVALID` (exit code 2). `data` is the
 * server's created ticket. A server refusal keeps its code, e.g. `PROJECT_NOT_FOUND` (exit code
 * 4) or `UNKNOWN_WORKFLOW_TYPE` (exit code 2). `pidgen ticket template` writes a file to start
 * from.
 *
 * `--domain <domain>` files a Domain Epic: an Epic that holds work from the domain's projects,
 * filed in the domain's home and owning no branch. The body is sent with `kind: epic` and
 * `domain_id` instead of `project_id`; see `createTicket`. `--kind story` or `--kind task` with it,
 * or a file naming `project_id`, `branch_mode` or `feature_branch`, is `INPUT_INVALID` (exit 2).
 * The server's `DOMAIN_HAS_NO_PROJECTS` exits 5, `DOMAIN_PROJECT_CONFLICT` and
 * `EPIC_FIELD_REFUSED` exit 2, `DOMAIN_NOT_FOUND` exits 4, and a 403 exits 3.
 */
export const ticketCreate: CommandSpec = {
  path: ["ticket", "create"],
  summary:
    "Create a ticket from a JSON or YAML file; --kind epic files an Epic, --domain a Domain Epic",
  configure(command: Command) {
    command
      .requiredOption(
        "-f, --file <file>",
        "the ticket as JSON or YAML (see pidgen ticket template); - reads standard input",
      )
      .addOption(kindOption("the kind of ticket to create; epic files an Epic"))
      .option(...DOMAIN_OPTION);
  },
  async run(ctx, { options, global }) {
    return createTicket(
      ctx,
      global,
      String(options["file"]),
      givenKind(options),
      givenDomain(options),
    );
  },
};
