import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";

/** Where `ticket template` writes when `--output` is not given, relative to the working directory. */
export const DEFAULT_TEMPLATE_FILE = "ticket.yaml";

/**
 * The annotated ticket file. Every value in it is valid as written, so `pidgen ticket create -f` accepts
 * the file unchanged; the placeholders say what to replace.
 */
export const TICKET_TEMPLATE = `# A ticket for \`pidgen ticket create -f <this file>\`.
#
# title and objective are required; every other field is optional and may be deleted, in which
# case the server's default (shown here) applies. Unknown fields are refused. The CLI checks
# the file against the public API document before sending it: an invalid file exits 2 and
# sends nothing.
#
# Readiness: before a ticket runs, the server scores it and needs 60 of 100, and an
# estimated_complexity. The "Readiness:" note on each field says the points it earns; a
# ticket that reaches implementation_ready earns 15 more.

# A one-line summary people will see in lists.
title: Replace with a one-line title

# What must be true when the ticket is done, and why it matters.
objective: >-
  Replace with the outcome this ticket delivers and the reason for it.

# The project: its id (proj-...) or its ticket-key prefix. \`pidgen project list\` lists them.
project_id: EXAMPLE

# Optional Account Agent ID (not a model name), 1-80 characters. Omit or use null to
# select the Project default, else the Account's reserved Unassigned Agent.
# Uncomment to select an Agent; eligibility and active-run effects belong to the server.
# team_member_id: AGENT-EXAMPLE
# The Agent is chosen when the ticket is created; to change it later,
# an edit file naming team_member_id reassigns the ticket (\`pidgen ticket edit\`).
# Never put version in an edit file: the CLI GETs the Ticket and adds its version to PATCH
# without retrying conflicts.

# The Epic to file the ticket in, by key (e.g. EXAMPLE-12) or id; null for none. An Epic is a
# ticket of kind epic (\`pidgen ticket list --kind epic\` lists them). To file an Epic itself, use
# \`pidgen ticket create --kind epic\` and leave this out: an Epic has no parent.
parent_ticket_id: null

# A registered workflow type; \`pidgen ticket types\` lists the valid keys.
workflow_type: implementation

# Scheduling priority; the server's default is 5.
priority: 5

# How large the work is, from 1 (small) to 10 (large). Replace the 3 with your estimate;
# null, the server's default, leaves it unestimated.
# Readiness: no points, but a ticket without an estimated_complexity is never ready to run,
# whatever its score.
estimated_complexity: 3

# What is deliberately in and out of scope; null for nothing stated.
# Readiness: 10 points when stated.
scope_boundaries: null

# Each criterion needs only a statement: one observable behaviour the change must have.
# priority is MUST, SHOULD or COULD. assertion is optional: a plain-language restatement of what
# a verifier would see when the criterion holds; delete it to leave it out. The implementer finds
# or writes the tests that prove each criterion.
# Advanced: add test_assertion only when one specific command must run to prove the criterion
# (a pinned check, e.g. \`test_assertion: npm test -- login\`). Leave it out otherwise.
# Readiness: 10 points per criterion, at most 30; 5 more per MUST criterion, at most 20.
acceptance_criteria:
  - statement: Replace with one observable behaviour the change must have
    priority: MUST
    assertion: Replace with what a verifier would see when it holds

# Measurable targets: a name and a target, with an optional unit.
# Readiness: 10 points for at least one.
success_metrics: []

# What the implementer should read first: research findings, specifications, code references.
# Each has a type and content, and optionally a reference_url. Uncomment the example to add one.
# Readiness: 5 points each, at most 15.
context_artifacts: []
#   - type: research_finding
#     content: Replace with what the implementer needs to know
#     reference_url: https://pidgen.example.com/docs/example

# Capabilities the work needs, e.g. a language or a tool, as plain names.
# Readiness: no points; the readiness score does not count them.
required_capabilities: []

# Facts the work takes as given.
assumptions: []

# Questions still open for whoever refines the ticket.
# Readiness: minus 5 points per question.
open_questions: []

# auto resolves eligible approval gates itself and leaves oversight to the delivered pull request;
# manual waits for a person at every approval gate.
approval_mode: auto

# manual or auto; null inherits the Epic's, then the project's, merge policy.
merge_policy: null

# true starts refinement as soon as the ticket is created in Backlog.
start_refinement: false
`;

/**
 * `pidgen ticket template [-o <file>] [--force]`: writes the annotated ticket file (`ticket.yaml` in
 * the working directory by default) to fill in for `pidgen ticket create -f`. It calls no route. An
 * existing file is kept unless `--force` is given: `CLI_USAGE` (exit code 2). `data` is the path
 * written and its format.
 */
export const ticketTemplate: CommandSpec = {
  path: ["ticket", "template"],
  summary: "Write an annotated ticket file to fill in for ticket create",
  configure(command: Command) {
    command
      .option("-o, --output <file>", "where to write the file", DEFAULT_TEMPLATE_FILE)
      .option("--force", "overwrite the file if it exists", false);
  },
  async run(ctx, { options }) {
    const output = String(options["output"] ?? "").trim();
    if (output === "") throw usageError("--output needs a file path.", { option: "--output" });
    const path = resolve(ctx.cwd, output);
    try {
      await writeFile(path, TICKET_TEMPLATE, { flag: options["force"] === true ? "w" : "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw usageError(`${output} already exists; pass --force to overwrite it.`, {
          option: "--output",
          path,
        });
      }
      throw new CliError(
        "CLI_INTERNAL",
        `Cannot write ${output}: ${code ?? String(error)}`,
        ExitCode.Unexpected,
        { path },
      );
    }
    return { data: { path, format: "yaml" } };
  },
};
