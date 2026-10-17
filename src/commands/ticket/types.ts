import type { components } from "../../generated/api.js";
import { readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";

type WorkflowType = components["schemas"]["WorkflowTypeResource"];

/**
 * `pidgen ticket types`: the workflow types registered in the Account (`GET /workflow-types`),
 * ordered by key. They are the valid values of a ticket's `workflow_type`; each carries its
 * `key`, `label`, `workflow_name` and `ticket_count`.
 */
export const ticketTypes: CommandSpec = {
  path: ["ticket", "types"],
  summary: "List the workflow types a ticket's workflow_type may name",
  async run(ctx, { global }) {
    return readRoute<WorkflowType[]>(ctx, global, "/workflow-types");
  },
};
