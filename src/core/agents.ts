import type { RunContext } from "./context.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import { findOnPath, runForeground, type WorkerRuntime } from "./worker.js";

/**
 * The coding agents `pidgen setup` installs and signs in to, and `pidgen worker login` signs in
 * to: their npm package, login and status commands. Which harness kinds exist, and the command
 * the worker runs for each, is the server's worker release list (`GET /workers/releases`); this
 * table only says how to install and sign in to the ones setup handles.
 */

export type AgentKind = "claude" | "codex";

export interface CodingAgent {
  kind: AgentKind;
  /** The agent as a person knows it. */
  name: string;
  /** The command on `PATH`. */
  command: string;
  /** The npm package `npm install -g` installs it from. */
  npmPackage: string;
  /** The login, run with the terminal inherited. */
  login: readonly string[];
  /** The status command: exit 0 is signed in. */
  status: readonly string[];
}

export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    kind: "claude",
    name: "Claude Code",
    command: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    login: ["auth", "login"],
    status: ["auth", "status"],
  },
  {
    kind: "codex",
    name: "Codex",
    command: "codex",
    npmPackage: "@openai/codex",
    login: ["login", "--device-auth"],
    status: ["login", "status"],
  },
];

/** A harness the worker can run that setup shows when it is found, and never installs. */
export const SHOWN_ONLY_AGENTS = [{ kind: "pi", name: "Pi", command: "pi" }] as const;

export const AGENT_KINDS: readonly AgentKind[] = CODING_AGENTS.map((agent) => agent.kind);

/** Every harness kind the worker's capacity command knows: the ones setup handles, then Pi. */
export const WORKER_HARNESS_KINDS: readonly string[] = [
  ...AGENT_KINDS,
  ...SHOWN_ONLY_AGENTS.map((agent) => agent.kind),
];

/** A subscription plan of a coding agent, and how many sessions the worker runs on it at once. */
export interface AgentPlan {
  /** What `--plan <kind>=<id>` and the question take. */
  id: string;
  /** Other words the question and `--plan` take for it. */
  aliases: readonly string[];
  /** The plan as the question shows it. */
  name: string;
  /** The concurrent-session cap the worker gets for it. */
  cap: number;
}

/** The plan a person who does not know theirs gets: one session at a time. */
export const UNKNOWN_PLAN = "not-sure";

/** Each agent's plans, in the order the question lists them; the last is "Not sure". */
export const AGENT_PLANS: Readonly<Record<AgentKind, readonly AgentPlan[]>> = {
  claude: [
    { id: "pro", aliases: [], name: "Pro", cap: 1 },
    { id: "max-5x", aliases: ["max5x", "max"], name: "Max 5x", cap: 2 },
    { id: "max-20x", aliases: ["max20x"], name: "Max 20x", cap: 4 },
    {
      id: "api",
      aliases: ["api-key", "team", "enterprise"],
      name: "API key, Team or Enterprise",
      cap: 2,
    },
    { id: UNKNOWN_PLAN, aliases: ["unsure", "unknown"], name: "Not sure", cap: 1 },
  ],
  codex: [
    { id: "plus", aliases: [], name: "Plus", cap: 1 },
    { id: "pro", aliases: [], name: "Pro", cap: 3 },
    { id: "business", aliases: ["enterprise", "team"], name: "Business or Enterprise", cap: 2 },
    { id: "api", aliases: ["api-key"], name: "API key", cap: 2 },
    { id: UNKNOWN_PLAN, aliases: ["unsure", "unknown"], name: "Not sure", cap: 1 },
  ],
};

/**
 * The answers `pidgen setup`'s sessions question offers for each agent, lowest first, with the
 * plans each suits as its hint. They are starting values, not the providers' limits; Custom takes
 * any other number.
 */
export const SESSION_HINTS: Readonly<
  Record<AgentKind, ReadonlyArray<{ sessions: number; hint: string }>>
> = {
  claude: [
    { sessions: 1, hint: "Pro, or not sure" },
    { sessions: 2, hint: "Max 5x, API key, Team or Enterprise" },
    { sessions: 4, hint: "Max 20x" },
  ],
  codex: [
    { sessions: 1, hint: "Plus, or not sure" },
    { sessions: 2, hint: "Business, Enterprise or API key" },
    { sessions: 3, hint: "Pro" },
  ],
};

/** The agent's plan named `word` (an id or an alias, any case), or `undefined`. */
export function findPlan(kind: AgentKind, word: string): AgentPlan | undefined {
  const wanted = word.trim().toLowerCase();
  return AGENT_PLANS[kind].find((plan) => plan.id === wanted || plan.aliases.includes(wanted));
}

export function codingAgent(kind: AgentKind): CodingAgent {
  return CODING_AGENTS.find((agent) => agent.kind === kind)!;
}

/** `npm install -g <package>`, as a person types it. */
export function agentInstallCommand(agent: CodingAgent): string {
  return ["npm", ...agentInstallArgs(agent)].join(" ");
}

export function agentInstallArgs(agent: CodingAgent): string[] {
  return ["install", "-g", agent.npmPackage];
}

/** `<command> <login args>`, as a person types it. */
export function agentLoginCommand(agent: CodingAgent): string {
  return [agent.command, ...agent.login].join(" ");
}

export function agentStatusCommand(agent: CodingAgent): string {
  return [agent.command, ...agent.status].join(" ");
}

/** `ready`: signed in; `not_ready`: not; `unknown`: the agent has no status command to ask. */
export type AgentLogin = "ready" | "not_ready" | "unknown";

/** An agent that answers its status command with an unknown command is an older release. */
const UNKNOWN_COMMAND = /unknown (sub)?command|unrecognized (sub)?command|unexpected argument/i;

/**
 * The environment an agent runs in: the CLI's own, without `CLAUDE_CONFIG_DIR` or `CODEX_HOME`,
 * so it signs in to its default home, which the worker reads.
 */
export function agentEnvironment(ctx: Pick<RunContext, "env" | "homeDir">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: ctx.homeDir, ...ctx.env };
  delete env["CLAUDE_CONFIG_DIR"];
  delete env["CODEX_HOME"];
  return env;
}

/** The agent's executable on `PATH`, or `null`. */
export function findAgent(
  ctx: Pick<RunContext, "env" | "cwd">,
  agent: Pick<CodingAgent, "command">,
  runtime: WorkerRuntime,
): Promise<string | null> {
  return findOnPath(ctx, agent.command, runtime);
}

/**
 * Runs the agent's status command with its output captured (not shown): exit 0 is `ready`; an
 * agent that cannot run it, or does not know it, is `unknown`; anything else is `not_ready`.
 */
export function agentStatus(
  ctx: Pick<RunContext, "env" | "homeDir" | "cwd">,
  executable: string,
  agent: CodingAgent,
  runtime: WorkerRuntime,
): Promise<AgentLogin> {
  return new Promise((resolveStatus) => {
    let settled = false;
    const settle = (login: AgentLogin) => {
      if (settled) return;
      settled = true;
      resolveStatus(login);
    };
    const child = runtime.spawn(executable, [...agent.status], {
      cwd: ctx.cwd,
      env: agentEnvironment(ctx),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const output: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.once("error", () => settle("unknown"));
    child.once("close", (code: number | null) => {
      if (code === 0) return settle("ready");
      const text = Buffer.concat(output).toString("utf8");
      settle(code === 127 || UNKNOWN_COMMAND.test(text) ? "unknown" : "not_ready");
    });
  });
}

/** Runs the agent's login in the foreground, with the terminal inherited; its exit status. */
export function runAgentLogin(
  ctx: Pick<RunContext, "env" | "homeDir" | "cwd">,
  executable: string,
  agent: CodingAgent,
  runtime: WorkerRuntime,
): Promise<number> {
  return runForeground(
    { env: agentEnvironment(ctx), homeDir: ctx.homeDir, cwd: ctx.cwd },
    executable,
    agent.login,
    runtime,
    () => agentNotFound(agent),
  );
}

/** The agent is not on `PATH`: `AGENT_NOT_FOUND` (exit 2) with its install command as the fix. */
export function agentNotFound(agent: CodingAgent, message?: string): CliError {
  const install = agentInstallCommand(agent);
  return new CliError(
    "AGENT_NOT_FOUND",
    message ?? `${agent.name} (${agent.command}) is not on PATH. Install it with \`${install}\`.`,
    ExitCode.Usage,
    { harness: agent.kind, command: install, fix: `Install ${agent.name}: \`${install}\`.` },
  );
}
