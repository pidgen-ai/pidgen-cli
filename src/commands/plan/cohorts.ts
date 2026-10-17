import { CohortInputSchema, proposeCohorts } from "../../core/cohorts.js";
import { inputInvalid, readInput } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";
import { usageError } from "../../core/errors.js";

/**
 * `pidgen plan cohorts -f <slices> [--max-children <n>]`: proposes delivery cohorts for a batch of
 * planned slices from the files each will edit and the slices each needs. Local only: it reads the
 * file, prints the proposal, and sends nothing. See docs/commands.md, "plan".
 */
export const planCohorts: CommandSpec = {
  path: ["plan", "cohorts"],
  summary: "Group planned slices into delivery cohorts by shared files (local, sends nothing)",
  configure(command) {
    command
      .requiredOption("-f, --file <file>", "slices as JSON or YAML; - reads standard input")
      .option("--max-children <n>", "split a group larger than this into chained cohorts");
  },
  async run(ctx, { options }) {
    const input = await readInput(ctx, options["file"] as string);
    const parsed = CohortInputSchema.safeParse(input.value);
    if (!parsed.success) {
      throw inputInvalid(`Input ${input.source} is not a slice list`, {
        source: input.source,
        issues: parsed.error.issues.map((issue) => ({
          path: ["$", ...issue.path].join("."),
          message: issue.message,
        })),
      });
    }
    const request = parsed.data;
    const max = options["maxChildren"];
    if (max !== undefined) {
      const value = Number(max);
      if (!Number.isInteger(value) || value < 1) {
        throw usageError(`--max-children must be a positive integer, got ${String(max)}`);
      }
      request.max_children = value;
    }
    return { data: proposeCohorts(request) };
  },
};
