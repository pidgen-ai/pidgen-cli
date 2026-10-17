import type { Command } from "commander";
import { pathSegment, readRoute } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import type { components } from "../../generated/api.js";

type RunNodeResource = components["schemas"]["RunNodeResource"];

/**
 * `pidgen run node-output <run> <node>`: one node of a workflow run
 * (`GET /runs/{run_id}/nodes/{node_id}`). `data` is the server's node unchanged: its `status`,
 * every attempt oldest first (each with its output or error) and `output`, the latest attempt's
 * output (`value`, `artifacts`, `evidence`, `output_digest`) or `null` until it produces one. An
 * unknown run is the server's `RUN_NOT_FOUND` and a node with no attempt in the run its
 * `NODE_NOT_FOUND` (both exit code 4). Both arguments are required; a missing one is a usage error
 * (exit code 2) and nothing is sent.
 */
export const runNodeOutput: CommandSpec = {
  path: ["run", "node-output"],
  summary: "Show one node's output in a run",
  configure(command: Command) {
    command
      .argument("<run>", "the run's id, e.g. WFR-…")
      .argument("<node>", "the node's id in the workflow, e.g. implement");
  },
  async run(ctx, { args, global }) {
    const run = pathSegment("run id", args[0]);
    const node = pathSegment("node id", args[1]);
    return readRoute<RunNodeResource>(ctx, global, `/runs/${run}/nodes/${node}`);
  },
};
