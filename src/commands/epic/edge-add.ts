import { Option, type Command } from "commander";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";

type DependencyEdge = components["schemas"]["DependencyEdge"];
type DepType = components["schemas"]["DepType"];

/** The values of `--type`: the public API document's `DepType`. */
export const DEP_TYPES: readonly DepType[] = ["blocks", "informs", "parallel_safe"];

/** The options `epic edge add` and `epic edge rm` share: the edge's two endpoints and its type. */
export function configureEdge(command: Command): void {
  command
    .argument("<key>", "the Epic's key, e.g. PIDGEN-12, or its id")
    .requiredOption(
      "--from <ref>",
      "the prerequisite ticket or Epic: its key, e.g. PIDGEN-2, or its id",
    )
    .requiredOption("--to <ref>", "the ticket or Epic that depends on it: its key or id")
    .addOption(new Option("--type <type>", "how --to depends on --from").choices([...DEP_TYPES]));
}

/**
 * The edge a command names, as the ticket dependency routes take it: `target` is `--to`'s path
 * segment (the ticket that waits), `source` `--from`'s (its prerequisite), as given and as a path
 * segment, and the type when `--type` is given.
 */
export interface EdgeTarget {
  target: string;
  source_id: string;
  source: string;
  dep_type?: DepType;
}

/**
 * Reads `<key> --from <ref> --to <ref> [--type <type>]`. A missing, empty, `.` or `..` key, `--from`
 * or `--to` is a usage error (exit code 2) and nothing is sent. The key names the Epic the edge is
 * filed under for the caller; the edge itself is the ordinary dependency between the two tickets.
 */
export function edgeTarget(args: string[], options: Record<string, unknown>): EdgeTarget {
  pathSegment("epic key", args[0]);
  const endpoint = (flag: "--from" | "--to", value: unknown): string => {
    const ref = typeof value === "string" ? value.trim() : "";
    if (ref === "" || ref === "." || ref === "..") {
      throw usageError(`${flag} needs a ticket key or id.`, { option: flag });
    }
    return ref;
  };
  const from = endpoint("--from", options["from"]);
  const to = endpoint("--to", options["to"]);
  const edge: EdgeTarget = {
    target: encodeURIComponent(to),
    source_id: from,
    source: encodeURIComponent(from),
  };
  if (options["type"] !== undefined) edge.dep_type = options["type"] as DepType;
  return edge;
}

/**
 * `pidgen epic edge add <key> --from <ref> --to <ref> [--type <type>]`: an alias of
 * `pidgen ticket dep add <--to> --on <--from>`. Declares that `--to` depends on `--from`
 * (`POST /tickets/{--to}/dependencies` with `source_id`, and `dep_type` when `--type` is given;
 * the server's default is `blocks`). Either end may be an Epic or a ticket of the same project.
 * `data` is the stored edge; adding an edge that exists answers it. The server's refusals keep
 * their codes: a cycle (`DEPENDENCY_CYCLE`) and the other graph refusals exit 5,
 * `TICKET_NOT_FOUND` and `DEPENDENCY_ENDPOINT_NOT_FOUND` exit 4.
 */
export const epicEdgeAdd: CommandSpec = {
  path: ["epic", "edge", "add"],
  summary: "Add a dependency edge: --to depends on --from (ticket dep add)",
  configure: configureEdge,
  async run(ctx, { args, options, global }) {
    const { target, source_id, dep_type } = edgeTarget(args, options);
    const session = await openSession(ctx, global);
    const response = await session.client.request<DependencyEdge>({
      method: "POST",
      path: `/tickets/${target}/dependencies`,
      body: dep_type ? { source_id, dep_type } : { source_id },
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
