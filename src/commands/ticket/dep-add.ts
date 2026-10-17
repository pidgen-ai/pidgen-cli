import { Option, type Command } from "commander";
import { usageError } from "../../core/errors.js";
import { pathSegment } from "../../core/read.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import type { components } from "../../generated/api.js";
import { DEP_TYPES } from "../epic/edge-add.js";

type DependencyEdge = components["schemas"]["DependencyEdge"];
type DepType = components["schemas"]["DepType"];

/** The options `ticket dep add` and `ticket dep rm` share: the prerequisite and the edge's type. */
export function configureDependency(command: Command): void {
  command
    .argument("<ref>", "the ticket that waits: its key, e.g. PIDGEN-3, or its id")
    .requiredOption("--on <ref>", "the prerequisite ticket it waits for: its key or id")
    .addOption(new Option("--type <type>", "how <ref> depends on --on").choices([...DEP_TYPES]));
}

/** The dependency a command names: the waiting ticket's path segment, its prerequisite and type. */
export interface DependencyTarget {
  ref: string;
  source_id: string;
  dep_type?: DepType;
}

/**
 * Reads `<ref> --on <ref> [--type <type>]`. A missing, empty, `.` or `..` ref, or an empty `--on`,
 * is a usage error (exit code 2) and nothing is sent.
 */
export function dependencyTarget(
  args: string[],
  options: Record<string, unknown>,
): DependencyTarget {
  const ref = pathSegment("ticket ref", args[0]);
  const on = typeof options["on"] === "string" ? options["on"].trim() : "";
  if (on === "") throw usageError("--on needs a ticket key or id.", { option: "--on" });
  const target: DependencyTarget = { ref, source_id: on };
  if (options["type"] !== undefined) target.dep_type = options["type"] as DepType;
  return target;
}

/**
 * `pidgen ticket dep add <ref> --on <ref> [--type <type>]`: declares that `<ref>` depends on `--on`
 * (`POST /tickets/{ref}/dependencies`), sending `--on` as `source_id` and `--type` as `dep_type`
 * when given (the server's default is `blocks`). Both must be tickets of the same project. `data`
 * is the stored edge; adding an edge that exists answers it. The server's refusals keep their
 * codes: the graph's refusals (`DEPENDENCY_CYCLE`, `DEPENDENCY_SELF_EDGE`, …) exit 5,
 * `TICKET_NOT_FOUND` and `DEPENDENCY_ENDPOINT_NOT_FOUND` exit 4.
 */
export const ticketDepAdd: CommandSpec = {
  path: ["ticket", "dep", "add"],
  summary: "Make a ticket wait for another: <ref> depends on --on",
  configure: configureDependency,
  async run(ctx, { args, options, global }) {
    const { ref, ...body } = dependencyTarget(args, options);
    const session = await openSession(ctx, global);
    const response = await session.client.request<DependencyEdge>({
      method: "POST",
      path: `/tickets/${ref}/dependencies`,
      body,
    });
    return { data: response.data, meta: session.meta(response) };
  },
};
