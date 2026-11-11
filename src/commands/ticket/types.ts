import pending from "../../../contracts/pending/workflow-types.json" with { type: "json" };
import type { components } from "../../generated/workflow-types.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { schemaIssues, type OpenApiDocument } from "../../core/input.js";
import { readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

type WorkflowTypeResource = components["schemas"]["WorkflowTypeResource"];

/** A listed type: `when_to_use` and `workflow_title` always present, null when the server sent none. */
export type WorkflowType = Omit<WorkflowTypeResource, "when_to_use" | "workflow_title"> & {
  when_to_use: string | null;
  workflow_title: string | null;
};

/**
 * The pending fragment holding the route with `when_to_use` and `workflow_title` added, bundled
 * into the CLI at build time. When the server publishes them they are pulled with
 * `contracts/openapi.json` and the fragment is deleted.
 */
export const WORKFLOW_TYPES_DOCUMENT: OpenApiDocument = pending;

const ROUTE = "/workflow-types";

/**
 * `pidgen ticket types`: the workflow types registered in the Account (`GET /workflow-types`),
 * ordered by key. They are the valid values of a ticket's `workflow_type`; each carries its
 * `key`, `label`, `workflow_name`, `ticket_count`, its When to use (`when_to_use`) and its
 * workflow's display title (`workflow_title`). A server that does not send those two yet is read
 * as sending null. An answer that does not match the contract is `UNEXPECTED_RESPONSE` (exit 1).
 */
export const ticketTypes: CommandSpec = {
  path: ["ticket", "types"],
  summary: "List the workflow types a ticket's workflow_type may name, with When to use",
  async run(ctx, { global }) {
    const result = await readRoute<unknown>(ctx, global, ROUTE);
    const issues = schemaIssues(
      WORKFLOW_TYPES_DOCUMENT,
      { type: "array", items: { $ref: "#/components/schemas/WorkflowTypeResource" } },
      result.data,
    );
    if (issues.length > 0) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        `The server's workflow types do not match the contract (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
        ExitCode.Unexpected,
        { route: `GET /api/v1${ROUTE}`, issues },
      );
    }
    const data: WorkflowType[] = (result.data as WorkflowTypeResource[]).map((type) => ({
      ...type,
      when_to_use: type.when_to_use ?? null,
      workflow_title: type.workflow_title ?? null,
    }));
    return { ...result, data };
  },
};
