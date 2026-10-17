import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";
import { configureEdge, edgeTarget } from "./edge-add.js";

type DependencyEdge = components["schemas"]["DependencyEdge"];

/**
 * `pidgen epic edge rm <key> --from <ref> --to <ref> [--type <type>]`: an alias of
 * `pidgen ticket dep rm <--to> --on <--from>`. Removes the edge by which `--to` depends on
 * `--from` (`DELETE /tickets/{--to}/dependencies/{--from}`, each percent-encoded as one path
 * segment, with `dep_type` as a query parameter when `--type` is given). `data` is the edge
 * removed. The server's refusals keep their codes: `TICKET_NOT_FOUND`,
 * `DEPENDENCY_ENDPOINT_NOT_FOUND` and `DEPENDENCY_NOT_FOUND` exit 4; `DEPENDENCY_TARGET_FROZEN`
 * and `DEPENDENCY_SELF_EDGE` exit 5.
 */
export const epicEdgeRm: CommandSpec = {
  path: ["epic", "edge", "rm"],
  summary: "Remove a dependency edge (ticket dep rm)",
  configure: configureEdge,
  async run(ctx, { args, options, global }) {
    const { target, source, dep_type } = edgeTarget(args, options);
    const session = await openSession(ctx, global);
    const response = await session.client.request<DependencyEdge>({
      method: "DELETE",
      path: `/tickets/${target}/dependencies/${source}`,
      ...(dep_type ? { query: { dep_type } } : {}),
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
