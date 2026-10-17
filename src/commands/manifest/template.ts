import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parse } from "yaml";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";

const DEFAULT_OUTPUT = "ticket-manifest.yaml";
const DEFAULT_CHILDREN = 2;
/** The most children a manifest may have, as the manifest contract states. */
export const MAX_MANIFEST_CHILDREN = 50;

const HEADER = `# A ticket manifest for \`pidgen manifest apply -f <this file>\`: one new high-level ticket (the
# root), its children, the edges among them and where they are filed, committed together.
#
# Preview first: \`pidgen manifest apply -f <this file>\` sends nothing that changes anything. The
# server checks the whole manifest and reports every finding at once, grouped by ref, with
# committable, promotable and the preview_digest. Fix every finding the preview reports, then
# preview again. Commit with \`pidgen manifest apply -f <this file> --apply\` (or
# \`--apply --digest <preview_digest>\`). Nothing exists on the server until the commit, and the
# commit writes everything or nothing.
#
# Every value here is valid as written; replace the placeholders. Unknown fields are refused, and
# the CLI checks the file against the manifest contract before sending it.
#
# Readiness: a ticket runs only with 60 of 100 points and an estimated_complexity. The
# "Readiness:" note on each field says the points it earns. The root is scored in Backlog; each
# child lands at implementation_ready, which earns 15 more. With children, a root that is not
# ready blocks the commit; a child that is not ready blocks promotion only.
`;

const PLACEMENT = `
# The manifest format; leave it as it is.
schema_version: pidgen.ticket-manifest.v1

# The Project: its id (proj-...) or its ticket-key prefix. \`pidgen project list\` lists them.
project_id: EXAMPLE

# The Epic to file the root under: a ticket of kind epic, by key (e.g. EXAMPLE-12) or id; null for
# none. It becomes the root's parent_ticket_id; the manifest names it epic_id. Children take the
# root's Project, Epic and approval mode.
epic_id: null

# manual or auto; null inherits the Epic's, then the Project's, merge policy.
merge_policy: null

# true promotes the root and its children for execution in the same commit; every promotion gate
# must then pass, and a finding that blocks promotion blocks the commit too. Set it only when the
# person asked for the work to run.
promote: false

# Why the work is split this way; recorded with the child plan. Up to 4000 characters.
summary: Replace with why the work is split into these children.
`;

interface ContentOptions {
  /** Spaces before each field. */
  indent: number;
  /** Prefix for placeholder text, e.g. `the root` or `child 1`. */
  name: string;
  /** Prefix for criterion refs, unique in the ticket. */
  refPrefix: string;
  /** How many MUST criteria the placeholder carries. */
  criteria: number;
  /** The first field of a list item, written with `- ` (the child's ref), if any. */
  agentNote: string;
}

/** The content fields the root and every child share, each annotated. */
function contentFields(options: ContentOptions): string {
  const pad = " ".repeat(options.indent);
  const { name, refPrefix } = options;
  const extraCriteria = Array.from({ length: Math.max(0, options.criteria - 1) }, (_, index) => {
    const n = index + 2;
    return `${pad}  # Another criterion: only a statement is needed, and priority defaults to MUST.
${pad}  - statement: Replace with observable behaviour ${n} of ${name}.
`;
  }).join("");
  return `${pad}# A one-line title, 1-200 characters; children's titles are unique in the manifest.
${pad}# Readiness: no points.
${pad}title: Replace with the one-line title of ${name}
${pad}# What must be true when the work is done, and why it matters.
${pad}# Readiness: no points; required.
${pad}objective: Replace with the outcome ${name} delivers and how to tell it is done.
${pad}# A registered workflow type; \`pidgen ticket types\` lists the keys.
${pad}# Readiness: no points.
${pad}workflow_type: implementation
${pad}# Scheduling priority, 1 (highest) to 10; defaults to 5.
${pad}# Readiness: no points.
${pad}priority: 5
${pad}# How large the work is, from 1 (small) to 10 (large). Replace the 3 with your estimate.
${pad}# Readiness: no points, but required: without it the ticket is never ready, whatever its
${pad}# score (TICKET_COMPLEXITY_REQUIRED).
${pad}estimated_complexity: 3
${pad}# What is deliberately in and out of scope; null for nothing stated.
${pad}# Readiness: 10 points when stated.
${pad}scope_boundaries: "In: replace with what ${name} covers. Out: replace with what it leaves alone."
${pad}# Each criterion needs only a statement: one observable behaviour the work must have.
${pad}# Readiness: 10 points per criterion, at most 30; 5 more per MUST criterion, at most 20.
${pad}acceptance_criteria:
${pad}  # ref names the criterion in findings and becomes its id; null lets the server mint one.
${pad}  - ref: ${refPrefix}-first
${pad}    # One observable behaviour the work must have.
${pad}    statement: Replace with observable behaviour 1 of ${name}.
${pad}    # MUST (the default), SHOULD or COULD.
${pad}    priority: MUST
${pad}    # Optional: what a verifier would see when the criterion holds; null for none.
${pad}    assertion: Replace with what a verifier sees when behaviour 1 holds.
${pad}    # Advanced: a pinned check, one command whose exit code decides the criterion
${pad}    # (e.g. npm test -- login). Leave it null otherwise.
${pad}    test_assertion: null
${pad}    # How the criterion is verified; unit_test by default.
${pad}    verification_type: unit_test
${extraCriteria}${pad}# Measurable targets: a name and a target, with an optional unit and current value.
${pad}# Readiness: 10 points for at least one.
${pad}success_metrics:
${pad}  # What is measured.
${pad}  - name: Replace with what is measured for ${name}
${pad}    # The value that means done, as text.
${pad}    target: "0"
${pad}    # Optional unit, e.g. ms or %.
${pad}    unit: ""
${pad}    # Optional value today, as text; null when unknown.
${pad}    current: null
${pad}# What the implementer should read first: briefs, research findings, code references.
${pad}# Readiness: 5 points each, at most 15.
${pad}context_artifacts:
${pad}  # The kind of context, e.g. brief, research_finding or code_reference.
${pad}  - type: brief
${pad}    # stage for a starting brief; reference (the default) for background.
${pad}    tier: stage
${pad}    # The text: the files to change, the pattern to copy, the narrowest test.
${pad}    content: Replace with the files to change, the pattern to copy and the narrowest test.
${pad}    # Optional link; null for none.
${pad}    reference_url: null
${pad}# Facts the work takes as given; an open question answered here is settled.
${pad}# Readiness: no points.
${pad}assumptions: []
${pad}# Questions still open. An open question not settled in assumptions blocks promotion.
${pad}# Readiness: minus 5 points per question.
${pad}open_questions: []
${pad}# Capabilities the work needs, e.g. a language or a tool, as plain names.
${pad}# Readiness: no points; the score does not count them.
${pad}required_capabilities: []
${pad}# ${options.agentNote}
${pad}# Uncomment to select an Agent of the Account (an Agent ID, not a model name); null is refused.
${pad}# team_member_id: AGENT-EXAMPLE
`;
}

function rootBlock(): string {
  return `
# The new high-level ticket, created in Backlog.
root:
  # The root's reference in findings and in the commit result; defaults to root.
  ref: root
  # Reserved for revising an existing ticket; must stay null.
  ticket: null
${contentFields({
  indent: 2,
  name: "the root",
  refPrefix: "root",
  criteria: 3,
  agentNote: "Omitted, the root takes the Project's default Agent, else the Unassigned Agent.",
})}  # auto resolves eligible approval gates itself and leaves oversight to the delivered pull
  # request; manual waits for a person at every approval gate. Children take the root's.
  approval_mode: auto
  # Where the work came from; api unless you have a reason. A reserved source is refused.
  source: api
  # Your own id for the work in that source; null for none.
  source_id: null
`;
}

function childrenBlock(count: number): string {
  const intro = `
# The planned children of the root, 0-${MAX_MANIFEST_CHILDREN}, each with the same content fields as the root.
# Readiness: a child lands at implementation_ready, which earns it 15 points beyond the fields.
`;
  if (count === 0) return `${intro}children: []\n`;
  const children = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `  # A child's ref is unique in the manifest; edges, findings and the commit result use it.
  - ref: child-${n}
${contentFields({
  indent: 4,
  name: `child ${n}`,
  refPrefix: `child-${n}`,
  criteria: 2,
  agentNote: "Omitted, a child takes the Agent the root's chain assigns.",
})}`;
  }).join("");
  return `${intro}children:\n${children}`;
}

function edgesBlock(count: number): string {
  const intro = `
# \`target\` depends on \`source\`; each names a child by ref (never the root, which waits for
# its children anyway). Blocks edges may not form a cycle.
`;
  if (count < 2) {
    return `${intro}# With two children, an edge reads (dep_type: blocks, the default, informs or
# parallel_safe):
#   - source: child-1
#     target: child-2
#     dep_type: blocks
edges: []
`;
  }
  const edges = Array.from({ length: count - 1 }, (_, index) => {
    const n = index + 1;
    return `  # The prerequisite child, by ref.
  - source: child-${n}
    # The dependent child, by ref.
    target: child-${n + 1}
    # blocks (the default): the target waits for the source; informs: the source's outcome
    # is context for the target; parallel_safe: the two may run at the same time.
    dep_type: blocks
`;
  }).join("");
  return `${intro}edges:\n${edges}`;
}

/**
 * The annotated manifest `pidgen manifest template` writes, with `children` children chained by
 * blocks edges. Every placeholder is valid, so the file as written is a manifest
 * `pidgen manifest apply` accepts; replace the placeholders before committing it.
 */
export function manifestTemplateYaml(children: number): string {
  return `${HEADER}${PLACEMENT}${rootBlock()}${childrenBlock(children)}${edgesBlock(children)}`;
}

/**
 * `pidgen manifest template [-o <file>] [--children <n>] [--force]`: writes an annotated ticket
 * manifest to fill in. Local only: it writes one file, prints where, and sends nothing. A `.json`
 * output gets the same manifest as JSON, without the comments. See docs/commands.md, "manifest".
 */
export const manifestTemplate: CommandSpec = {
  path: ["manifest", "template"],
  summary: "Write an annotated ticket manifest to fill in (local, sends nothing)",
  configure(command) {
    command
      .option("-o, --output <file>", `where to write the manifest (default ${DEFAULT_OUTPUT})`)
      .option(
        "--children <n>",
        `how many children to write, 0-${MAX_MANIFEST_CHILDREN} (default ${DEFAULT_CHILDREN})`,
      )
      .option("--force", "overwrite the file if it exists");
  },
  async run(ctx, { options }) {
    const children = childCount(options["children"]);
    const output = typeof options["output"] === "string" ? options["output"] : DEFAULT_OUTPUT;
    if (output.trim() === "")
      throw usageError("--output needs a file path.", { option: "--output" });
    const path = resolve(ctx.cwd, output);
    const format = extname(output).toLowerCase() === ".json" ? "json" : "yaml";
    const yaml = manifestTemplateYaml(children);
    const content = format === "json" ? `${JSON.stringify(parse(yaml), null, 2)}\n` : yaml;
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
    return { data: { path: output, format, children } };
  },
};

function childCount(value: unknown): number {
  if (value === undefined) return DEFAULT_CHILDREN;
  const text = typeof value === "string" ? value.trim() : "";
  const count = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(count) || count > MAX_MANIFEST_CHILDREN) {
    throw usageError(
      `--children takes a whole number from 0 to ${MAX_MANIFEST_CHILDREN}, not "${String(value)}".`,
      { option: "--children" },
    );
  }
  return count;
}
