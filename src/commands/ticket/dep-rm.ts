import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";
import { configureDependency, dependencyTarget } from "./dep-add.js";

type DependencyEdge = components["schemas"]["DependencyEdge"];

/**
 * `pidgen ticket dep rm <ref> --on <ref> [--type <type>]`: removes the edge by which `<ref>` depends
 * on `--on` (`DELETE /tickets/{ref}/dependencies/{source}`, `--on` percent-encoded as one path
 * segment, and `dep_type` as a query parameter when `--type` is given; the server's default is
 * `blocks`). `data` is the edge removed. The server's refusals keep their codes:
 * `TICKET_NOT_FOUND`, `DEPENDENCY_ENDPOINT_NOT_FOUND` and `DEPENDENCY_NOT_FOUND` exit 4;
 * `DEPENDENCY_SELF_EDGE` and `DEPENDENCY_TARGET_FROZEN` exit 5.
 */
export const ticketDepRm: CommandSpec = {
  path: ["ticket", "dep", "rm"],
  summary: "Remove the edge by which a ticket waits for another",
  configure: configureDependency,
  async run(ctx, { args, options, global }) {
    const { ref, source_id, dep_type } = dependencyTarget(args, options);
    const source = pathSegment("prerequisite ticket ref", source_id);
    const session = await openSession(ctx, global);
    const response = await session.client.request<DependencyEdge>({
      method: "DELETE",
      path: `/tickets/${ref}/dependencies/${source}`,
      ...(dep_type ? { query: { dep_type } } : {}),
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
