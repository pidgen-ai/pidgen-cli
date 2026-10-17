import type { Command } from "commander";
import { optionalText } from "../../core/domains.js";
import type { CommandSpec } from "../../core/registry.js";
import { REQUEST_ROUTES, requestArgument, triageRequest } from "../../core/requests.js";

/**
 * `pidgen request promote <request> [--project <project>] [--workflow-type <type>] [--no-refine]`:
 * promotes an accepted Request to a Ticket in the Project it targets
 * (`POST /requests/{request_id}/promote`) with the version just read, carrying all its attachments.
 * `--project` confirms that Project; another is refused with `REQUEST_TARGET_NEEDS_PROJECT`, as is
 * a Request that targets a Domain or nothing. Refinement starts unless `--no-refine`
 * (`start_refinement: false`). A retry answers the same Ticket. `data` is
 * `{state, request, ticket_id}`.
 */
export const requestPromote: CommandSpec = {
  path: ["request", "promote"],
  summary: "Promote an accepted Request to a Ticket in the Project it targets",
  configure(command: Command) {
    requestArgument(command)
      .option(
        "--project <project>",
        "the Project the request targets, to confirm it: its id or key prefix",
      )
      .option("--workflow-type <type>", "the Ticket's workflow type, e.g. implementation")
      .option("--no-refine", "do not start refinement");
  },
  async run(ctx, { args, options, global }) {
    const body: Record<string, unknown> = {};
    const project = optionalText(options, "project");
    if (project !== undefined) body["project_id"] = project;
    const workflowType = optionalText(
      { "workflow-type": options["workflowType"] },
      "workflow-type",
    );
    if (workflowType !== undefined) body["workflow_type"] = workflowType;
    if (options["refine"] === false) body["start_refinement"] = false;
    return triageRequest(ctx, global, args, REQUEST_ROUTES.promote, body);
  },
};
