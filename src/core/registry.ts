import type { Command } from "commander";
import type { GlobalOptions, RunContext } from "./context.js";
import type { Meta } from "./envelope.js";
import type { PresentationContext } from "./human.js";

/**
 * One CLI command. Every command module exports one of these and is listed in `commands`
 * (src/commands/index.ts). The skill lint reads the same list, so a skill can only name
 * commands that exist.
 */
export interface CommandSpec {
  /**
   * `[noun, verb]`, e.g. `["skills", "install"]`, or `[noun, group, verb]` for a verb under a
   * group listed in `GROUPS`, e.g. `["epic", "edge", "add"]`. A command with no verb, such as
   * `pidgen feedback`, is `[name]`.
   */
  path: readonly [string] | readonly [string, string] | readonly [string, string, string];
  summary: string;
  /** Adds arguments and options to the verb's commander command. */
  configure?(command: Command): void;
  run(ctx: RunContext, input: CommandInput): Promise<CommandResult | DirectCommandResult>;
}

export interface CommandInput {
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
}

export interface CommandResult {
  envelope?: true;
  data: unknown;
  meta?: Partial<Omit<Meta, "cli_version">>;
  presentation?: Pick<PresentationContext, "responseStatus" | "now">;
  /**
   * The command's own rendering for a terminal (`--format table`), in place of the generic rendering
   * of `data`, such as setup's summary card. JSON output is unaffected.
   */
  human?: string;
}

/** A foreground handoff controls the process status and deliberately emits no CLI envelope. */
export interface DirectCommandResult {
  exitCode: number;
  envelope: false;
}

/** One-line descriptions for each noun, shown in `pidgen --help`. */
export const NOUNS: Record<string, string> = {
  auth: "Sign in and manage CLI credentials",
  account: "List and switch Pidgen Accounts",
  project: "Read projects, and inspect, set up, rehearse and diagnose their workspaces",
  domain: "Domains: groups of projects, their parents, Domain Members and Maintainers",
  contract: "Read, revise and accept a project's or a domain's contracts",
  ticket: "Create, read, and recover tickets",
  intent: "Submit prose work, and answer, list or withdraw its requests",
  request: "Submit, list, show and triage Requests: bugs, features, tasks and questions",
  epic: "Epics (epic-kind tickets): aliases of the ticket commands with --kind epic",
  plan: "Child plans and promotion",
  manifest: "File a ticket, its children and their edges as one previewed manifest",
  review: "Tickets waiting on a person",
  run: "Workflow runs and node output",
  node: "Enroll and run a worker node",
  session: "Steer an agent session and read, edit and withdraw its instructions",
  skills: "Install the Pidgen agent skills",
  api: "Call a public API route directly",
};

/** One-line descriptions for each group of verbs under a noun, keyed `"<noun> <group>"`. */
export const GROUPS: Record<string, string> = {
  "epic dag": "Read an Epic's dependency graph",
  "epic edge": "Add and remove dependency edges (aliases of ticket dep add and rm)",
  "ticket dep": "Add, remove and list a ticket's dependencies",
  "ticket contract":
    "Link a ticket to a contract it implements or builds against, or remove the link",
  "domain project": "Add and remove the projects a domain contains",
  "domain parent": "Add and remove a domain's parent domains",
  "domain member": "Add and remove Domain Members",
  "domain maintainer": "Make a Domain Member a Maintainer, or stop them maintaining",
};

export function commandName(spec: CommandSpec): string {
  return spec.path.join(" ");
}
