import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parse } from "yaml";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";

const DEFAULT_OUTPUT = "child-plan.yaml";

/**
 * The annotated plan `pidgen plan template` writes. Every placeholder is valid, so the file as
 * written is a plan `pidgen plan apply` accepts; replace the placeholders before applying it.
 */
export const PLAN_TEMPLATE_YAML = `# A complete child plan for \`pidgen plan apply <root> -f <this file>\`.
#
# List every child the root ticket will have. A current child you leave out is superseded
# (abandoned), and the preview then requires the supersedes_children acknowledgement.
# \`pidgen plan show <root>\` lists the current children with their plan_item_id.
# Preview first (\`pidgen plan apply <root> -f child-plan.yaml\`), then apply with
# \`--apply --digest <preview_digest>\`.

# Why the plan looks like this; recorded with it. Up to 4000 characters.
summary: Split the work into a first slice and a follow-up.

children:
  # A new child: give it a key of your choosing, unique in the plan. Dependencies name it by key.
  # To keep a current child instead, replace \`key\` with its \`plan_item_id\` (exactly one of the two).
  - key: first-slice
    # Unique within the plan, 1-200 characters.
    title: First slice
    objective: Describe the outcome this child delivers and how to tell it is done.
    # A workflow type registered in the Account; \`pidgen ticket types\` lists them.
    workflow_type: implementation
    # Optional team_member_id selects this child's Agent: an Account Agent ID, not a model
    # name. Omitted, a kept child keeps its Agent and a new child takes the Project default.
    # A kept child that has already started keeps its Agent; another is refused.
    # 1 (highest) to 10; defaults to 5.
    priority: 5
    # 1 to 10; defaults to 3.
    estimated_complexity: 3
    # Each criterion needs only a statement: one observable behaviour the child must have.
    # priority is MUST (the default), SHOULD or COULD. assertion is optional: a plain-language
    # restatement of what a verifier would see when the criterion holds.
    # Advanced: add test_assertion only when one specific command must run to prove the
    # criterion (a pinned check whose exit code decides it). Leave it out otherwise.
    acceptance_criteria:
      - statement: The first behaviour works as described.
        priority: MUST
        assertion: A verifier sees the first behaviour happen as described.
    success_metrics:
      - name: Tests for the first slice
        target: pass
    assumptions: []
    open_questions: []
    # A starting brief for this child: the files to change, the pattern to copy, the contract
    # rows and the narrowest test. Give it in one of two forms, never both. Inline, at most 3
    # items, each with content of 1-8192 characters:
    # context_artifacts:
    #   - type: brief
    #     tier: stage
    #     content: Files to change, pattern to copy, contract rows, the narrowest test.
    # Or from a file, a path relative to this file, whose text (1-8192 characters) is sent as
    # one brief. Needs a server that publishes briefs; an older one refuses the field.
    # brief_file: briefs/first-slice.md

  - key: follow-up
    title: Follow-up slice
    objective: Describe the follow-up outcome and how to tell it is done.
    workflow_type: implementation
    acceptance_criteria:
      - statement: The follow-up behaviour works as described.

# \`target\` depends on \`source\`; each names a child of this plan by key or plan_item_id.
# dep_type: blocks (the default), informs, or parallel_safe.
dependencies:
  - source: first-slice
    target: follow-up
    dep_type: blocks
`;

/**
 * `pidgen plan template [-o <file>] [--force]`: writes an annotated child plan to fill in. Local
 * only: it writes one file, prints where, and sends nothing. A `.json` output gets the same plan
 * as JSON, without the comments. See docs/commands.md, "plan".
 */
export const planTemplate: CommandSpec = {
  path: ["plan", "template"],
  summary: "Write an annotated child plan file to fill in (local, sends nothing)",
  configure(command) {
    command
      .option("-o, --output <file>", `where to write the plan (default ${DEFAULT_OUTPUT})`)
      .option("--force", "overwrite the file if it exists");
  },
  async run(ctx, { options }) {
    const output = typeof options["output"] === "string" ? options["output"] : DEFAULT_OUTPUT;
    const path = resolve(ctx.cwd, output);
    const format = extname(output).toLowerCase() === ".json" ? "json" : "yaml";
    const content =
      format === "json"
        ? `${JSON.stringify(parse(PLAN_TEMPLATE_YAML), null, 2)}\n`
        : PLAN_TEMPLATE_YAML;
    try {
      await writeFile(path, content, { flag: options["force"] === true ? "w" : "wx" });
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? String(error);
      if (reason === "EEXIST") {
        throw new CliError(
          "FILE_EXISTS",
          `${output} already exists; choose another --output or pass --force to overwrite it.`,
          ExitCode.Refused,
          { path: output },
        );
      }
      throw new CliError("CLI_INTERNAL", `Cannot write ${output}: ${reason}`, ExitCode.Unexpected, {
        path: output,
      });
    }
    return { data: { path: output, format } };
  },
};
