import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Option, type Command } from "commander";
import { parse as parseYaml } from "yaml";
import {
  AGENT_KINDS,
  agentEnvironment,
  agentInstallArgs,
  agentInstallCommand,
  agentNotFound,
  agentStatus,
  AGENT_PLANS,
  SESSION_HINTS,
  CODING_AGENTS,
  codingAgent,
  findAgent,
  findPlan,
  SHOWN_ONLY_AGENTS,
  WORKER_HARNESS_KINDS,
  type AgentKind,
  type AgentLogin,
  type CodingAgent,
} from "../../core/agents.js";
import { DEFAULT_SERVER_URL, loadConfig, resolveTarget, type Target } from "../../core/config.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import type { DoctorCheck } from "../../core/doctor.js";
import {
  drawCollapsed,
  drawFailed,
  drawOutro,
  drawTaskLine,
  PromptCancelled,
  SYMBOL,
  type InterruptReason,
  type Prompter,
  type PromptOption,
  type Spinner,
  type TaskLog,
  type Wait,
} from "../../core/prompter.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import {
  ENROLL_ROLES,
  ENROLL_SCOPE,
  enrollPermission,
  readMe,
  targetCredentialKind,
  type EnrollPermission,
  type Me,
} from "../../core/me.js";
import type { CommandInput, CommandResult, CommandSpec } from "../../core/registry.js";
import { openSession, responseMeta } from "../../core/session.js";
import { skillsStatus } from "../../core/skills.js";
import { packageIndex, resolveUpdate } from "../../core/worker-index.js";
import { readWorkerReleases, selectSeries } from "../../core/worker-releases.js";
import { CLI_VERSION } from "../../core/version.js";
import {
  assertSupportedPlatform,
  collectedOutput,
  findOnPath,
  readWorkerCredential,
  type WorkerCredential,
  resolvePidgenHome,
  runWorkerCapacity,
  workerPlatformSupported,
  workerStatus as localWorkerStatus,
} from "../../core/worker.js";
import {
  displayArgument,
  installWorker,
  readInstallRecord,
  RUNTIME_INSTRUCTIONS,
  sharedUvWorker,
  WORKER_EULA_LINK,
  type InstallRecord,
  type WorkerForm,
} from "../../core/worker-install.js";
import { ensureInstallId, invalidInstallIdNote } from "../../core/install-id.js";
import type { WorkerList, WorkerResource } from "../../core/worker-enrollments.js";
import {
  liveWorkersNamed,
  newestOfInstall,
  sameName,
  sameServer,
  workerLabel,
  workerName,
} from "../../core/worker-identity.js";
import { accountUse } from "../account/use.js";
import {
  loginWithDeviceCode,
  parseServerUrl,
  type DeviceCodeShown,
  type DeviceToken,
  type PendingDeviceLogin,
  type PollReport,
} from "../auth/login.js";
import { doctorChecks } from "../doctor/doctor.js";
import { workerDoctor } from "../worker/doctor.js";
import { enrollWorker, NAME_TAKEN, workerEnroll } from "../worker/enroll.js";
import { workerLogin } from "../worker/login.js";
import { workerStart } from "../worker/start.js";
import { workerUpdate } from "../worker/update.js";
import { serverView, WORKERS_ROUTE, type ServerView } from "../worker/status.js";
import { workerVerify } from "../worker/verify.js";
import { SetupLog } from "./log.js";

/** The hosted Pidgen service, signed in to when no server is configured and `--url` is not given. */
export const HOSTED_SERVICE_URL = DEFAULT_SERVER_URL;

/** How often setup reads `GET /workers` while waiting for the worker to connect. */
const CONNECT_POLL_MS = 2_000;
/** The longest enrollment label the public API document accepts. */
const LABEL_MAX = 100;
/** The most sessions at a time `--sessions` and the Custom answer take (the worker's own limit). */
const SESSIONS_MAX = 64;
/** What setup says when the person presses Ctrl-C at a prompt, or during a task. */
const CANCELLED = "Setup cancelled. Everything before this is kept.";

/** The sign-in wait's live line, before its elapsed time. */
const WAITING = "Waiting for you to approve in the browser…";
/** The sign-in wait's key line. */
const WAIT_KEYS = "Enter open in browser · n new code · Esc other options";
/** What setup asks when the sign-in wait stops without an approval. */
const NOT_FINISHED = "Sign-in isn't finished. What next?";

/** What the sign-in wait's question offers. */
type NotFinished = "retry" | "token" | "quit";

/** How a sign-in that can no longer be approved is said, by the poll's code. */
const SIGN_IN_ENDED: Readonly<Record<string, string>> = {
  expired_token: "The code expired before the sign-in was approved.",
  access_denied: "The sign-in was denied in the browser.",
  invalid_grant: "Pidgen no longer recognises this sign-in.",
};
/** `invalid_grant` after a poll that failed on the network: that poll used the code. */
const ANSWER_LOST =
  "The approval's answer was lost on the way back, so this code can't be used again.";

/** A length of time as the wait shows it: `12s`, `1m 12s`. */
function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** One poll as the setup log records it: its outcome, never a code or the token. */
function pollLine(report: PollReport): string {
  switch (report.outcome) {
    case "slow_down":
      return `poll: slow_down; interval now ${report.interval}s`;
    case "network":
      return `poll: network error (${report.error ?? "no answer"})`;
    default:
      return `poll: ${report.outcome}`;
  }
}

/**
 * Doctor checks a later step fixes, so they do not stop setup: sign-in, the coding agents (one
 * `harness:<kind>` check each), and the install.
 */
const FIXED_LATER = new Map([
  ["credential", "signing in"],
  ["harness", "choosing coding agents"],
  ["worker", "installing"],
]);

/** The step that fixes a failing doctor check, or `undefined` when none does. */
function fixedLater(id: string): string | undefined {
  return FIXED_LATER.get(id.startsWith("harness:") ? "harness" : id);
}

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  linux: "Linux",
  darwin: "macOS",
};

/** `major.minor` of a version. */
function minorVersion(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

/** The check step's one line: "This machine is ready · Linux · Node.js 24.16 · git 2.43". */
function machineReady(platform: NodeJS.Platform, checks: readonly DoctorCheck[]): string {
  const parts = [
    "This machine is ready",
    PLATFORM_NAMES[platform] ?? platform,
    `Node.js ${minorVersion(process.versions.node)}`,
  ];
  const git = /^git (\d+\.\d+)/.exec(checks.find((entry) => entry.id === "git")?.summary ?? "");
  if (git !== null) parts.push(`git ${git[1]}`);
  return parts.join(" · ");
}

/**
 * Whether a doctor warning applies to what setup does, and so is shown: not one a later step
 * fixes, and not the container runtime's (its cosign check) while setup installs only the wheel.
 */
function warningApplies(check: DoctorCheck): boolean {
  if (fixedLater(check.id) !== undefined) return false;
  return !(check.id === "runtime" && !SETUP_FORMS.includes("container"));
}

export type SetupStepId =
  | "check"
  | "sign-in"
  | "agents"
  | "agent-login"
  | "capacity"
  | "runtime"
  | "install"
  | "enroll"
  | "prove";
export type SetupStepStatus = "done" | "skipped" | "failed";

/** Each `data.steps` id as a failure names it. */
const STEP_TITLES: Readonly<Record<SetupStepId, string>> = {
  check: "Check this machine",
  "sign-in": "Sign in to Pidgen",
  agents: "Choose coding agents",
  "agent-login": "Sign in to coding agents",
  capacity: "Size coding agent sessions",
  runtime: "Install the worker",
  install: "Install the worker",
  enroll: "Enroll and start the worker",
  prove: "Prove the worker works",
};

/** uv's own installer, which setup offers to run when the machine lacks uv. */
const UV_INSTALLER_URL = "https://astral.sh/uv/install.sh";
/** The installer as a person runs it: what setup prints and gives as the fix. */
export const UV_INSTALL_COMMAND = `curl -LsSf ${UV_INSTALLER_URL} | sh`;

/** One entry of `data.steps`: the step, what became of it, and the command it ran or stands for. */
export interface SetupStep {
  id: SetupStepId;
  status: SetupStepStatus;
  /** The `pidgen` command(s) the step runs, joined with `&&`; `null` for the runtime question. */
  command: string | null;
  summary: string;
  [detail: string]: unknown;
}

/** What a step's body reports; the runner adds its `id` and `command`. */
interface StepResult {
  status: SetupStepStatus;
  summary: string;
  [detail: string]: unknown;
}

interface Answers {
  runtime: WorkerForm | undefined;
  version: string | undefined;
  /** `--test`: install a release rehearsal from TestPyPI. */
  test: boolean;
  /** The worker's name in the Account: `--label`, else this host's name. */
  label: string;
  /** Whether `--label` gave it, answering the name question in advance. */
  labelGiven: boolean;
  url: string;
  /** `--agent`, in the order given, without repeats: the coding agents question answered. */
  agents: AgentKind[];
  /** `--plan <kind>=<plan>`: each agent's sessions question answered, by plan id. */
  plans: Partial<Record<AgentKind, string>>;
  /** `--sessions <kind>=<n>`: each agent's sessions question answered. */
  sessions: Partial<Record<AgentKind, number>>;
  /** `--accept-licence`: the install question answered yes. */
  acceptLicence: boolean;
  /** `--verbose`: each task's commands and output shown as it runs. */
  verbose: boolean;
}

/**
 * `pidgen setup [--runtime wheel] [--version <version>] [--test] [--label <label>] [--url <url>]
 * [--agent <agent>]… [--sessions <agent>=<n>]… [--plan <agent>=<plan>]… [--accept-licence]
 * [--verbose]`: the guided path from a fresh machine to a verified worker connected to the App
 * Service, and the CLI's one interactive command. It draws in clack's frame on standard error
 * (`┌  Pidgen setup`), asks each question as a clack prompt (`ctx.prompter`), and each answered
 * question collapses to one `◇` line. The screen shows only the current action: each task (an
 * install, the enrollment, the start) is a spinner that collapses to one `◇` line, and the
 * commands it runs and their output go to the setup log (`~/.pidgen/logs/setup-<time>.log`, the
 * newest ten kept); `--verbose` shows them under the task as it runs, and a failing task keeps its
 * last ten lines on screen. `data.steps` reports the parts by id:
 *
 * 1. `check`: offers to install uv when the machine lacks it, then `pidgen doctor`; a failing check
 *    a later step cannot fix stops setup.
 * 2. `sign-in`: `pidgen auth login <url>` (device code), the Account question (a select) only when
 *    the User belongs to more than one, then whether the credential may enroll workers.
 * 3. `agents`: which coding agents the worker runs (a multiselect; `--agent`), installing the
 *    missing ones ticked with npm.
 * 4. `agent-login`: `pidgen worker login <agent>` for each chosen agent not signed in.
 * 5. `capacity`: how many sessions each chosen agent runs at once (a select of numbers with plan
 *    hints plus Custom; `--sessions <agent>=<n>` or `--plan <agent>=<plan>`).
 * 6. `runtime`: the wheel, the one form setup offers, so nothing is asked; `install`: one confirm,
 *    install pidgen-worker <version> and accept its licence (`--accept-licence`), then
 *    `pidgen worker install` and `pidgen worker verify`.
 * 7. `enroll`: `pidgen worker enroll --label <name> -- --host-id <name>` unless this install's
 *    worker home holds a credential the server lists unrevoked (a clash with another install's
 *    worker asks for a free name), the caps (`pidgen-worker capacity set`) and
 *    `pidgen worker start --detach` (never without a credential), then waits until `GET /workers`
 *    reports this worker connected.
 * 8. `prove`: `pidgen worker doctor`.
 *
 * It ends with `└  Done in <m> min <s> s`: in a terminal on standard output, with the summary card
 * (what was set up, how to manage it, the one next thing to do); with JSON on standard error. A
 * signed-in profile, an installed worker and an enrolled host are detected and skipped, so running
 * it again resumes: a part-done machine says what is done in one line and, before it starts the
 * worker, asks whether to update to a newer release on the installed one's track first (yes asks
 * the licence question for it; `--accept-licence` answers both), and a finished one asks whether to
 * check everything (which names a newer release), change the coding agents or sessions, or update
 * the worker. A credential that cannot enroll workers stops it at sign-in. A failed step stops it with one block
 * on screen (what failed and why, the fix, the log, where a re-run continues) and, in JSON, the
 * step, the command, its error and the fix. Ctrl-C at a prompt stops it with
 * `SETUP_CANCELLED` (exit 2), keeping what was done. Without a terminal it exits 2 with
 * `TERMINAL_REQUIRED` and the equivalent commands.
 */
/**
 * The forms `pidgen setup` offers. `pidgen worker install --runtime container` installs the
 * container form; guiding a person through it in setup is planned.
 */
const SETUP_FORMS: readonly WorkerForm[] = ["wheel"];

export const setup: CommandSpec = {
  path: ["setup"],
  summary:
    "Guided setup: sign in, install, enroll and start a worker (the one interactive command)",
  configure(command: Command) {
    command
      .addOption(
        new Option(
          "--runtime <runtime>",
          "the worker runtime, answering the question in advance (the container form is planned)",
        ).choices([...SETUP_FORMS]),
      )
      .option("--version <version>", "a worker release of a series the server accepts")
      .option("--test", "install the worker from TestPyPI, where release rehearsals are published")
      .option("--label <label>", "the worker's name in the Account (default: this host's name)")
      .option(
        "--url <url>",
        `the Pidgen server (default: the configured one, else ${HOSTED_SERVICE_URL})`,
      )
      .addOption(
        new Option(
          "--agent <agent>",
          `a coding agent for the worker (${AGENT_KINDS.join(" or ")}), answering the question in advance; repeatable`,
        )
          .argParser((value: string, previous: string[] = []) => [...previous, value])
          .default([]),
      )
      .addOption(
        new Option(
          "--plan <agent=plan>",
          `a coding agent's subscription plan, such as claude=max-5x, answering its sessions question in advance; repeatable`,
        )
          .argParser((value: string, previous: string[] = []) => [...previous, value])
          .default([]),
      )
      .addOption(
        new Option(
          "--sessions <agent=n>",
          `how many sessions a coding agent runs at once, such as claude=4, answering its question in advance; repeatable`,
        )
          .argParser((value: string, previous: string[] = []) => [...previous, value])
          .default([]),
      )
      .option(
        "--accept-licence",
        "install the worker and accept its licence, answering the install question in advance",
      )
      .option(
        "--verbose",
        "show each task's commands and their output as it runs (the setup log has them either way)",
      );
  },
  async run(ctx, { options, global }) {
    const answers = await readAnswers(ctx, options, global);
    const commands = new Commands(global, answers);
    if (ctx.prompter === null) {
      const equivalent = commands.equivalent();
      const error = new CliError(
        "TERMINAL_REQUIRED",
        "pidgen setup asks questions and needs a terminal on standard input and standard error. Run the commands in error.details.commands instead, in order.",
        ExitCode.Usage,
        { commands: equivalent },
      );
      error.human = [
        "pidgen setup asks questions and needs a terminal on standard input and standard error.",
        "Run these commands instead, in order:",
        ...equivalent.map((command) => `  ${command}`),
        "",
      ].join("\n");
      throw error;
    }
    const prompter = await ctx.prompter();
    const started = ctx.now();
    const log = SetupLog.open(ctx, started);
    try {
      writeLogHeader(log, ctx, answers, options, global, started);
      return await new SetupRun(ctx, prompter, global, answers, commands, log).run(started);
    } finally {
      log.close();
      // Its last lines reach the terminal before setup returns (up to two seconds).
      await prompter.close();
    }
  },
};

/** The top of the setup log: when, which CLI and Node.js, on what, against which server, how. */
function writeLogHeader(
  log: SetupLog,
  ctx: RunContext,
  answers: Answers,
  options: Record<string, unknown>,
  global: GlobalOptions,
  started: number,
): void {
  log.secret(ctx.env["PIDGEN_TOKEN"]);
  log.line("pidgen setup log");
  log.line(`started ${new Date(started).toISOString()}`);
  log.line(`pidgen CLI ${CLI_VERSION}`);
  log.line(`Node.js ${process.versions.node}`);
  log.line(`platform ${ctx.workerRuntime.platform} ${ctx.workerRuntime.arch ?? process.arch}`);
  log.line(`host ${ctx.hostName}`);
  log.line(`server ${answers.url}`);
  log.line(`flags ${flagsGiven(options, global) || "(none)"}`);
  log.line("");
}

/** The flags setup was run with, as a person types them. */
function flagsGiven(options: Record<string, unknown>, global: GlobalOptions): string {
  const flags: string[] = [];
  const add = (name: string, value: unknown) => {
    if (value === undefined || value === false) return;
    if (Array.isArray(value)) {
      for (const entry of value) flags.push(`--${name}`, String(entry));
      return;
    }
    flags.push(`--${name}`, ...(value === true ? [] : [String(value)]));
  };
  add("profile", global.profile);
  add("account", global.account);
  add("format", global.format);
  add("timeout", global.timeoutSeconds);
  for (const [key, value] of Object.entries(options)) {
    add(
      key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      value,
    );
  }
  return flags.map(displayArgument).join(" ");
}

async function readAnswers(
  ctx: RunContext,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<Answers> {
  const version = options["version"];
  if (version !== undefined && (typeof version !== "string" || version.trim() === "")) {
    throw usageError("--version needs a release version, such as 1.2.0.");
  }
  const label = options["label"];
  if (label !== undefined && (typeof label !== "string" || label.trim() === "")) {
    throw usageError("--label needs a name for the worker.");
  }
  const name = typeof label === "string" ? label.trim() : ctx.hostName;
  if (name.length > LABEL_MAX) {
    throw usageError(`--label must be at most ${LABEL_MAX} characters.`);
  }
  const given = options["url"];
  const url =
    typeof given === "string"
      ? parseServerUrl(given)
      : ((await configuredUrl(ctx, global)) ?? HOSTED_SERVICE_URL);
  const agents: AgentKind[] = [];
  for (const given of (options["agent"] as string[] | undefined) ?? []) {
    const kind = given.trim().toLowerCase();
    if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
      throw usageError(
        `--agent ${given} is not a coding agent setup can install: give ${AGENT_KINDS.join(" or ")}.`,
      );
    }
    if (!agents.includes(kind as AgentKind)) agents.push(kind as AgentKind);
  }
  const plans = readPlans((options["plan"] as string[] | undefined) ?? []);
  const sessions = readSessions((options["sessions"] as string[] | undefined) ?? []);
  for (const kind of AGENT_KINDS) {
    if (plans[kind] !== undefined && sessions[kind] !== undefined) {
      throw usageError(
        `--sessions ${kind}=… and --plan ${kind}=… both answer ${codingAgent(kind).name}'s sessions question: give one of them.`,
      );
    }
  }
  const fromEnvironment = ctx.env["PIDGEN_API_URL"];
  if (fromEnvironment !== undefined && !sameServer(fromEnvironment, url)) {
    throw usageError(
      `--url ${url} names another server than PIDGEN_API_URL (${fromEnvironment}). Give one of them.`,
    );
  }
  return {
    runtime: options["runtime"] as WorkerForm | undefined,
    version: typeof version === "string" ? version.trim() : undefined,
    test: options["test"] === true,
    label: name,
    labelGiven: typeof label === "string",
    url,
    agents,
    plans,
    sessions,
    acceptLicence: options["acceptLicence"] === true,
    verbose: options["verbose"] === true,
  };
}

/** `--sessions <kind>=<n>`: a whole number of sessions from 1 for each agent; a later one wins. */
function readSessions(given: readonly string[]): Partial<Record<AgentKind, number>> {
  const sessions: Partial<Record<AgentKind, number>> = {};
  for (const entry of given) {
    const [kind = "", count = ""] = entry.split("=", 2).map((part) => part.trim().toLowerCase());
    if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
      throw usageError(
        `--sessions ${entry} names no coding agent setup sizes: give ${AGENT_KINDS.map((agent) => `${agent}=<n>`).join(" or ")}.`,
      );
    }
    const number = wholeSessions(count);
    if (number === null) {
      throw usageError(
        `--sessions ${entry} needs a whole number of sessions from 1 to ${SESSIONS_MAX}, such as ${kind}=2.`,
      );
    }
    sessions[kind as AgentKind] = number;
  }
  return sessions;
}

/** A whole number of sessions from 1 to the worker's limit, or `null`. */
function wholeSessions(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const number = Number(text.trim());
  return number >= 1 && number <= SESSIONS_MAX ? number : null;
}

/** `--plan <kind>=<plan>`, each checked against the agent's plans; a later one for a kind wins. */
function readPlans(given: readonly string[]): Partial<Record<AgentKind, string>> {
  const plans: Partial<Record<AgentKind, string>> = {};
  for (const entry of given) {
    const [kind = "", plan = ""] = entry.split("=", 2).map((part) => part.trim().toLowerCase());
    if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
      throw usageError(
        `--plan ${entry} names no coding agent setup sizes: give ${AGENT_KINDS.map((agent) => `${agent}=<plan>`).join(" or ")}.`,
      );
    }
    const found = findPlan(kind as AgentKind, plan);
    if (found === undefined) {
      const ids = AGENT_PLANS[kind as AgentKind].map((candidate) => candidate.id).join(", ");
      throw usageError(
        `--plan ${entry} is not a ${codingAgent(kind as AgentKind).name} plan: give one of ${ids}.`,
      );
    }
    plans[kind as AgentKind] = found.id;
  }
  return plans;
}

/** The concurrent-session caps setup applies: one per harness kind the worker knows, and `prompts`. */
export type Caps = Record<string, number>;

/**
 * The `pidgen-worker capacity set` argument lists for the chosen agents' caps: each chosen agent's
 * `--max`, `--max 0` for every other harness the worker knows, then the prompt pool, `--min 1` and
 * the sum of the caps as `--max`.
 */
function capacityArgs(chosen: ReadonlyMap<AgentKind, number>): string[][] {
  const args: string[][] = [];
  for (const [kind, cap] of chosen) args.push(["set", kind, "--max", String(cap)]);
  for (const kind of WORKER_HARNESS_KINDS) {
    if (!chosen.has(kind as AgentKind)) args.push(["set", kind, "--max", "0"]);
  }
  const total = [...chosen.values()].reduce((sum, cap) => sum + cap, 0);
  args.push(["set", "prompts", "--min", "1", "--max", String(total)]);
  return args;
}

/** `pidgen-worker capacity <args>`, as a person types it. */
function capacityCommand(args: readonly string[]): string {
  return ["pidgen-worker", "capacity", ...args].map(displayArgument).join(" ");
}

/** "N session(s) at a time". */
function sessions(cap: number): string {
  return `${cap} session${cap === 1 ? "" : "s"} at a time`;
}

/** The configured server (`PIDGEN_API_URL`, then the profile), or `null` when there is none. */
async function configuredUrl(ctx: RunContext, global: GlobalOptions): Promise<string | null> {
  try {
    return resolveTarget(ctx, await loadConfig(ctx), global).url;
  } catch (error) {
    if (error instanceof CliError) return null;
    throw error;
  }
}

/** The `pidgen` commands setup runs, as a person would type them, with the global flags given. */
class Commands {
  constructor(
    private readonly global: GlobalOptions,
    private readonly answers: Answers,
  ) {}

  pidgen(words: readonly string[], options: { account?: boolean } = {}): string {
    const flags: string[] = [];
    if (this.global.profile !== undefined) flags.push("--profile", this.global.profile);
    if (options.account !== false && this.global.account !== undefined) {
      flags.push("--account", this.global.account);
    }
    return ["pidgen", ...[...flags, ...words].map(displayArgument)].join(" ");
  }

  doctor = () => this.pidgen(["doctor"]);
  login = () => this.pidgen(["auth", "login", this.answers.url], { account: false });
  tokenLogin = (account: string) =>
    this.pidgen(["auth", "login", this.answers.url, "--with-token", "--account", account], {
      account: false,
    });
  /** The token sign-in with the Account left for the person to fill in. */
  tokenLoginForAnyAccount = () =>
    `${this.pidgen(["auth", "login", this.answers.url, "--with-token", "--account"], { account: false })} <ACC-…>`;
  accountUse = (account: string) => this.pidgen(["account", "use", account], { account: false });
  install = (form: WorkerForm | undefined) =>
    this.pidgen([
      "worker",
      "install",
      ...(form !== undefined ? ["--runtime", form] : []),
      ...(this.answers.version !== undefined ? ["--version", this.answers.version] : []),
      ...(this.answers.test ? ["--test"] : []),
    ]);
  verify = () => this.pidgen(["worker", "verify"]);
  agentLogin = (agent: AgentKind) => this.pidgen(["worker", "login", agent], { account: false });
  /** `pidgen worker enroll`: the name is the enrollment's label and, after `--`, the worker's host id. */
  enroll = (name: string = this.answers.label, replace = false) =>
    this.pidgen([
      "worker",
      "enroll",
      ...(replace ? ["--replace-credential"] : []),
      "--label",
      name,
      "--",
      "--host-id",
      name,
    ]);
  start = () => this.pidgen(["worker", "start", "--detach"]);
  status = () => this.pidgen(["worker", "status"]);
  workerDoctor = () => this.pidgen(["worker", "doctor"]);

  /** What setup runs, in order, for a person without a terminal to run themselves. */
  equivalent(): string[] {
    return [
      this.doctor(),
      this.login(),
      ...this.answers.agents.map((agent) => this.agentLogin(agent)),
      this.install(this.answers.runtime),
      this.verify(),
      this.enroll(),
      ...this.capacity(),
      this.start(),
      this.status(),
      this.workerDoctor(),
    ];
  }

  /**
   * The capacity commands, when `--agent` with `--sessions` or `--plan` answer every question they
   * depend on.
   */
  private capacity(): string[] {
    const { agents, plans, sessions } = this.answers;
    const cap = (kind: AgentKind) =>
      sessions[kind] ?? (plans[kind] !== undefined ? findPlan(kind, plans[kind])!.cap : undefined);
    if (agents.length === 0 || agents.some((kind) => cap(kind) === undefined)) return [];
    const caps = new Map(agents.map((kind) => [kind, cap(kind)!] as const));
    return capacityArgs(caps).map(capacityCommand);
  }
}

/**
 * How a failure is drawn when it is not the generic block: the `■` line (what failed and why, in
 * plain words), the lines under it (the one fix), and the `└` line (where a re-run continues).
 */
interface FailureScreen {
  headline?: string;
  lines?: string[];
  end?: string;
}

/** A step that stopped: the command that failed, its error, and the fix. */
class StepFailure extends Error {
  constructor(
    readonly error: CliError,
    readonly command: string | null,
    readonly fix: string,
    readonly screen: FailureScreen = {},
  ) {
    super(error.message);
  }
}

/** Text for the screen: the backticks that mark commands in messages and fixes are dropped. */
function plainText(text: string): string {
  return text.replace(/`([^`]*)`/g, "$1");
}

/** What this machine had done before this run, as setup found it after signing in. */
interface Survey {
  /** The install setup keeps (the install step skips it), or `null`. */
  record: InstallRecord | null;
  /** This install's worker's name when it is enrolled, else `null`. */
  enrolled: string | null;
  running: boolean;
  /** Each coding agent's cap in the worker's `node.yaml`. */
  caps: Partial<Record<AgentKind, number>>;
}

/** What a run does: everything, asking again (`change`); on a finished setup, check and stop, or update. */
type RunMode = "change" | "check" | "update";

interface SignedIn {
  target: Target;
  me: Me;
  permission: EnrollPermission;
}

/** The Account's workers from `GET /workers`, or the refusal that kept them from being read. */
type WorkersRead = { list: WorkerList; refused: null } | { list: null; refused: CliError };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Sep": the day an ISO time falls on, in UTC; the text itself when it is not a time. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * Whether the Account lists an unrevoked worker named `name`: its `display_name`, compared
 * case-insensitively, or its `host_id` for a worker enrolled before names.
 */
function nameTaken(list: WorkerList, name: string): boolean {
  return liveWorker(list, name) !== undefined;
}

/** The Account's unrevoked worker named `name` (see `nameTaken`). */
function liveWorker(list: WorkerList, name: string): WorkerList["workers"][number] | undefined {
  return liveWorkersNamed(list, name)[0];
}

/**
 * The first of `<base>-2`, `<base>-3`, … no worker the Account lists is named (revoked ones
 * included; a worker's `display_name`, or its `host_id` for one enrolled before names) and the
 * server did not refuse in this run (`refused`, lower case), within the label limit. Names are
 * compared case-insensitively.
 */
function nextFreeName(
  list: WorkerList | null,
  base: string,
  refused: ReadonlySet<string> = new Set(),
): string {
  const listed = new Set(list?.workers.map((worker) => workerName(worker).toLowerCase()) ?? []);
  for (let number = 2; ; number++) {
    const suffix = `-${number}`;
    const name = `${base.slice(0, LABEL_MAX - suffix.length)}${suffix}`;
    const key = name.toLowerCase();
    if (!listed.has(key) && !refused.has(key)) return name;
  }
}

/** A name setup prefers to suggest, and why (the setup log records it). */
interface Preferred {
  name: string;
  why: string;
  /** Suggest it only while the Account lists a removed worker under it. */
  listedRemoved: boolean;
}

/** What a re-run of setup does after a failure. */
const CONTINUE = "Run `pidgen setup` again to continue from here.";

/** How many of a failing task's last lines of output stay on screen. */
const TAIL_LINES = 10;

/**
 * The task open now: a spinner (or, with `--verbose`, a task log) that ends in one line, the line
 * it ends in when it fails, and the last lines of its output in this run.
 */
interface ActiveTask {
  title: string;
  failure: string;
  spinner: Spinner | null;
  taskLog: TaskLog | null;
  /** The sign-in wait, which answers keys while it polls. */
  wait: Wait | null;
  tail: string[];
}

/** How one device code's wait ended. */
type WatchOutcome =
  | { kind: "approved"; token: DeviceToken }
  | { kind: "new" }
  | { kind: "escape" }
  | { kind: "ended"; line: string; code: string };

class SetupRun {
  private readonly steps: SetupStep[] = [];
  private active: ActiveTask | null = null;
  /** What the commands setup runs wrote that is not yet a whole line. */
  private pending = "";
  private readonly prompter: Prompter;
  private workerCheck: DoctorCheck | undefined;
  private signedIn: SignedIn | null = null;
  private form: WorkerForm | undefined;
  private skipInstall = false;
  /** The coding agents chosen at the agents step. */
  private agents: CodingAgent[] = [];
  /** Each chosen agent's cap, set when the capacity step ran in this invocation; else `null`. */
  private caps: Map<AgentKind, number> | null = null;
  /** What was done before this run; set at the sign-in step. */
  private survey: Survey | null = null;
  /** Whether the "Already done" or "Already set up" line named the install and the enrollment. */
  private reported = { install: false, enroll: false };
  private mode: RunMode = "change";
  /** The release a re-run offers to update the worker to. */
  private updateTo: string | null = null;
  /** The licence of the server's current release list, read with the newer release. */
  private updateLicence: string | null = null;
  /** Whether the "Already set up" line was shown: the re-run menu, not the update question, ran. */
  private setUp = false;
  /** Whether setup used a uv that `PATH` does not reach yet. */
  private uvOffPath = false;
  /** Ctrl-C during a task, or SIGTERM: what stopped setup, once it has. */
  private interruption: PromptCancelled | null = null;
  /** Rejects with the interruption: each step races its body against it. */
  private readonly interrupted: Promise<never>;
  private stop: (cancelled: PromptCancelled) => void = () => undefined;
  /** Aborted by an interruption: stops the sign-in wait's polling. */
  private readonly stopping = new AbortController();

  constructor(
    /** Replaced once, when the check step installs uv where `PATH` does not reach yet. */
    private ctx: RunContext,
    prompter: Prompter,
    private readonly global: GlobalOptions,
    private readonly answers: Answers,
    private readonly commands: Commands,
    private readonly log: SetupLog,
  ) {
    this.prompter = loggedPrompter(prompter, log, () => this.interruption);
    this.interrupted = new Promise<never>((_, reject) => {
      this.stop = reject;
    });
    this.interrupted.catch(() => undefined);
    prompter.onInterrupt((reason) => this.interrupt(reason));
  }

  /**
   * Ctrl-C during a spinner or the sign-in wait, or SIGTERM at any time: the step running now
   * stops as a cancelled prompt stops it (`SETUP_CANCELLED`, exit 2), and the sign-in wait stops
   * polling. The first one counts.
   */
  private interrupt(reason: InterruptReason): void {
    if (this.interruption !== null) return;
    this.interruption = new PromptCancelled(reason);
    this.log.event(reason === "sigterm" ? "terminated (SIGTERM)" : "answer: cancelled (Ctrl-C)");
    this.stopping.abort(this.interruption);
    this.stop(this.interruption);
  }

  /**
   * The context the commands setup runs get: what they write to standard error, and the output of
   * the commands they run in turn, goes to the setup log (and, with `--verbose`, under the task),
   * never straight to the screen.
   */
  private get quiet(): RunContext {
    return {
      ...this.ctx,
      io: { ...this.ctx.io, stderr: (text) => this.collect(text), pipeChildren: true },
    };
  }

  async run(started: number): Promise<CommandResult> {
    const c = this.commands;
    this.prompter.intro("Pidgen setup");
    await this.step("check", c.doctor(), () => this.check());
    await this.step("sign-in", c.login(), () => this.signIn());
    await this.step("agents", null, () => this.chooseAgents());
    const logins = this.agents.map((agent) => c.agentLogin(agent.kind)).join(" && ");
    await this.step("agent-login", logins || null, () => this.signInAgents());
    await this.step("capacity", null, () => this.sizeAgents());
    await this.step("runtime", null, () => this.chooseRuntime());
    const install = `${c.install(this.form)} && ${c.verify()}`;
    await this.step("install", install, () => this.install());
    await this.step("enroll", `${c.enroll()} && ${c.start()}`, () => this.enrollAndStart());
    await this.step("prove", c.workerDoctor(), () => this.prove());
    const next = await this.nextCommand();
    const seconds = Math.max(0, Math.round((this.ctx.now() - started) / 1000));
    const done = `Done in ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    const prove = this.steps.find((entry) => entry.id === "prove");
    if (prove !== undefined) prove["next"] = next.command;
    const result: CommandResult = {
      data: { steps: this.steps },
      meta: this.signedIn ? responseMeta(this.signedIn.target) : {},
    };
    if (this.global.format !== "table") {
      // Standard output is the envelope: the frame ends on standard error.
      this.prompter.outro(done);
      return result;
    }
    // In a terminal the frame ends on standard output, with the summary card under it.
    const card = await this.card(next);
    this.log.event(done);
    this.log.write(card);
    return { ...result, human: `${drawOutro(done)}${card}` };
  }

  /**
   * The summary card: what was set up, how to manage it, and the one next thing to do.
   */
  private async card(next: { command: string; why: string }): Promise<string> {
    const c = this.commands;
    const record = await readInstallRecord(this.ctx);
    const enroll = this.steps.find((entry) => entry.id === "enroll");
    const host =
      typeof enroll?.["host_id"] === "string" || typeof enroll?.["display_name"] === "string"
        ? workerLabel(
            typeof enroll["host_id"] === "string" ? enroll["host_id"] : null,
            typeof enroll["display_name"] === "string" ? enroll["display_name"] : null,
          )
        : this.answers.label;
    const current = this.caps === null ? await this.currentCaps() : {};
    const cap = (kind: AgentKind) => this.caps?.get(kind) ?? current[kind];
    const email = this.signedIn?.me.user.email;
    const rows: Array<[string, string[]]> = [
      ["Account", [[this.accountName(), ...(email ? [email] : [])].join(" · ")]],
      ["Worker", [`${host} · pidgen-worker ${record?.version ?? "(unknown)"} · running`]],
      [
        "Coding agents",
        this.agents.map((agent) => {
          const count = cap(agent.kind);
          return count !== undefined ? `${agent.name} · ${sessions(count)}` : agent.name;
        }),
      ],
    ];
    const label = Math.max(...rows.map(([name]) => name.length)) + 2;
    const manage: Array<[string, string]> = [
      [c.status(), "what it's doing now"],
      [c.pidgen(["worker", "stop"]), "stop it"],
      [c.pidgen(["setup"], { account: false }), "change coding agents or sessions"],
    ];
    const command = Math.max(...manage.map(([text]) => text.length)) + 4;
    const notes: string[] = [];
    if (this.uvOffPath) notes.push("Open a new terminal to use uv by name.");
    if (enroll?.["connected"] === null) {
      notes.push(`Check it's connected: ${c.status()}, signed in as an Owner or Administrator.`);
    }
    return [
      "",
      "  This machine is a Pidgen worker",
      ...notes.map((note) => `  ${note}`),
      "",
      ...rows.flatMap(([name, values]) =>
        values.map((value, index) => `  ${(index === 0 ? name : "").padEnd(label)}${value}`),
      ),
      "",
      "  Manage it",
      ...manage.map(([text, why]) => `    ${text.padEnd(command)}${why}`),
      "",
      `  Next: ${next.why}`,
      `    ${next.command}`,
      "",
    ].join("\n");
  }

  // -------------------------------------------------------------------------------------------
  // Running steps

  /**
   * Runs one step and records it in `data.steps`. A failure stops setup with the step, the command,
   * its error and the fix; Ctrl-C at one of its prompts stops it with `SETUP_CANCELLED`.
   */
  private async step(
    id: SetupStepId,
    command: string | null,
    body: () => Promise<StepResult>,
  ): Promise<void> {
    this.log.event(`${id} started`);
    try {
      if (this.interruption !== null) throw this.interruption;
      const running = body();
      // A body an interruption overtook goes on until its next task or question, which refuse.
      running.catch(() => undefined);
      const result = await Promise.race([running, this.interrupted]);
      const { status, summary, ...details } = result;
      this.steps.push({ id, status, command, summary, ...details });
      this.log.event(`${id} ${status}: ${summary}`);
    } catch (error) {
      this.flush();
      const failure =
        error instanceof StepFailure
          ? error
          : error instanceof CliError
            ? new StepFailure(error, command, "Fix the error.")
            : null;
      if (error instanceof PromptCancelled) {
        this.cancelTask();
        this.logError(id, error);
      } else if (failure === null) {
        this.failTask();
        this.logError(id, error);
      }
      if (error instanceof PromptCancelled) {
        this.steps.push({ id, command, status: "failed", summary: "Setup was cancelled." });
        this.prompter.cancel(CANCELLED, "Run pidgen setup again to continue.");
        const cancelled = new CliError("SETUP_CANCELLED", CANCELLED, ExitCode.Usage, {
          step: id,
          steps: this.steps,
        });
        // The cancel line is on screen; a terminal shows nothing more.
        cancelled.human = "";
        throw cancelled;
      }
      if (failure === null) throw error;
      this.steps.push({ id, command, status: "failed", summary: failure.error.message });
      const ran = failure.command ?? command;
      const given = failure.fix.trim();
      const fix = `${given}${/[.!?]$/.test(given) ? "" : "."} ${CONTINUE}`;
      const stopped = new CliError(
        failure.error.code,
        `Setup stopped at ${STEP_TITLES[id]}${ran ? `: \`${ran}\` failed` : ""}: ${failure.error.message} Fix: ${fix}`,
        failure.error.exitCode,
        {
          ...failure.error.details,
          step: id,
          command: ran,
          error: {
            code: failure.error.code,
            message: failure.error.message,
            details: failure.error.details,
          },
          fix,
          steps: this.steps,
          // Beside the failing command's own `log` (the worker's, say), never over it.
          setup_log: this.log.path,
        },
      );
      this.drawStop(id, failure, error);
      // The block is on screen; a terminal shows nothing more (JSON keeps every field).
      stopped.human = "";
      throw stopped;
    }
  }

  /**
   * The one block a failed step leaves on screen: the `■` line (the failed task's, or what stopped
   * setup and why), the task's last lines of output, the one fix, the setup log, and the `└` line
   * saying a re-run continues from here.
   */
  private drawStop(id: SetupStepId, failure: StepFailure, error: unknown): void {
    const screen = failure.screen;
    if (this.active !== null && screen.headline !== undefined) {
      this.active.failure = screen.headline;
    }
    const tail = this.failTask();
    this.logError(id, error);
    if (tail === null) {
      const headline =
        screen.headline ??
        `Setup stopped at ${STEP_TITLES[id]}: ${plainText(failure.error.message)}`;
      this.say(drawFailed(headline));
    }
    const lines: string[] = [];
    if (screen.lines !== undefined) {
      lines.push(...screen.lines);
    } else {
      // A task's own output says why it failed; without any, its error does.
      if (tail !== null && tail.length === 0) lines.push(plainText(failure.error.message));
      lines.push(plainText(failure.fix));
    }
    lines.push(`Log: ${this.shownPath(this.log.path)}`);
    for (const line of lines) this.say(drawTaskLine(line));
    this.say(`${SYMBOL.end}  ${screen.end ?? plainText(CONTINUE)}`);
  }

  /** Records a step's error in full: its code, message, details, and the stack of a defect. */
  private logError(id: SetupStepId, error: unknown): void {
    if (error instanceof PromptCancelled) {
      this.log.event(
        error !== this.interruption
          ? `${id} cancelled at a prompt`
          : error.reason === "sigterm"
            ? `${id} terminated (SIGTERM)`
            : `${id} cancelled (Ctrl-C)`,
      );
      return;
    }
    const failure = error instanceof StepFailure ? error.error : error;
    if (failure instanceof CliError) {
      this.log.event(`${id} failed: ${failure.code} ${failure.message}`);
      if (error instanceof StepFailure) {
        this.log.line(`command: ${error.command ?? "(none)"}`);
        this.log.line(`fix: ${error.fix}`);
      }
      this.log.line(
        `details: ${JSON.stringify({ step: id, ...failure.details }, null, 2) ?? "{}"}`,
      );
      return;
    }
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.log.event(`${id} failed: ${text}`);
  }

  /**
   * Runs one scriptable command, its line (`$ <display>`) first, with the quiet context unless
   * another is given: its output goes to the setup log. Its failure becomes the step's.
   */
  private async runCommand(
    command: string,
    spec: CommandSpec,
    input: Partial<CommandInput>,
    fix: (error: CliError) => string,
    ctx: RunContext = this.quiet,
    display: string | null = command,
  ): Promise<unknown> {
    if (display !== null) this.note(`$ ${display}`);
    try {
      const result = await spec.run(ctx, {
        args: input.args ?? [],
        options: input.options ?? {},
        global: input.global ?? this.global,
      });
      return "data" in result ? result.data : null;
    } catch (error) {
      if (error instanceof CliError) throw new StepFailure(error, command, fix(error));
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The screen, the log and tasks

  /** Text for the person: on the screen, and in the log. After an interruption, only the log. */
  private screen(text: string): void {
    this.flush();
    this.log.write(text);
    if (this.interruption === null) this.ctx.io.stderr(text);
  }

  /** One line for the person. */
  private say(text: string): void {
    this.screen(`${text}\n`);
  }

  /** `│\n◇  <line>`: a question answered in advance, or an action's one-line result. */
  private answered(line: string): void {
    this.say(drawCollapsed(line));
  }

  /** `│\n▲  <line>`: a warning that applies to what setup does. */
  private warn(line: string): void {
    this.say(`${SYMBOL.bar}\n${SYMBOL.warn}  ${line}`);
  }

  /** A line of setup's own that is not for the screen: in the log, and under the task. */
  private note(text: string): void {
    this.collect(`${text}\n`);
  }

  /**
   * What the commands setup runs write: the log takes it as it is; each whole line also joins the
   * open task's last lines and, with `--verbose`, is shown under it (a command's own lines
   * indented under the command).
   */
  private collect(text: string): void {
    this.log.write(text);
    this.pending += text;
    const end = this.pending.lastIndexOf("\n");
    if (end < 0) return;
    const lines = this.pending.slice(0, end).split("\n");
    this.pending = this.pending.slice(end + 1);
    for (const raw of lines) this.collected(raw);
  }

  /** Ends a last line a command left unfinished. */
  private flush(): void {
    if (this.pending === "") return;
    const line = this.pending;
    this.pending = "";
    this.log.write("\n");
    this.collected(line);
  }

  private collected(raw: string): void {
    // eslint-disable-next-line no-control-regex
    const line = this.log.redact(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, ""));
    if (line.trim() === "") return;
    const task = this.active;
    if (task !== null) {
      task.tail.push(line);
      if (task.tail.length > TAIL_LINES) task.tail.shift();
    }
    if (!this.answers.verbose) return;
    const shown = line.startsWith("$ ") ? line : `  ${line}`;
    if (task?.taskLog) task.taskLog.message(shown);
    else this.ctx.io.stderr(`${drawTaskLine(shown)}\n`);
  }

  /**
   * Opens a task: a spinner showing `title` (with `--verbose`, a task log under it), which ends in
   * one line. `failure` is the line it ends in if it fails.
   */
  private begin(title: string, failure: string): void {
    if (this.interruption !== null) throw this.interruption;
    if (this.active !== null) this.done(this.active.title);
    this.flush();
    this.log.event(`task: ${title}`);
    const task: ActiveTask = { title, failure, spinner: null, taskLog: null, wait: null, tail: [] };
    if (this.answers.verbose) {
      task.taskLog = this.prompter.taskLog(title);
    } else {
      task.spinner = this.prompter.spinner();
      task.spinner.start(title);
    }
    this.active = task;
  }

  /** What the open task is doing now; `failure`, when given, is the line it now ends in if it fails. */
  private progress(message: string, failure?: string): void {
    const task = this.active;
    if (task === null) return;
    this.log.event(`task: ${message}`);
    if (failure !== undefined) task.failure = failure;
    task.spinner?.message(message);
    task.taskLog?.message(message);
  }

  /**
   * Ends the open task without a line of its own: what comes next (a warning and a question) says
   * what became of it.
   */
  private dropTask(): void {
    const task = this.active;
    if (task === null) return;
    this.flush();
    this.active = null;
    this.log.event(`task ended: ${task.title}`);
    task.spinner?.clear();
    task.wait?.clear();
  }

  /** Ends the open task without a line: setup was cancelled while it ran. */
  private cancelTask(): void {
    const task = this.active;
    if (task === null) return;
    this.flush();
    this.active = null;
    this.log.event(`task cancelled: ${task.title}`);
    task.spinner?.clear();
    task.wait?.clear();
    task.taskLog?.error(CANCELLED);
  }

  /** Ends the open task in its one line. */
  private done(line: string): void {
    const task = this.active;
    if (task === null) return;
    this.flush();
    this.active = null;
    this.log.event(`task done: ${line}`);
    task.spinner?.stop(line);
    task.wait?.stop(line);
    task.taskLog?.success(line);
  }

  /**
   * Ends the open task as failed: its `■` line, then (without `--verbose`, which showed them) the
   * last lines of its output in this run, each once. Returns those lines, or `null` when no task
   * was open.
   */
  private failTask(): string[] | null {
    const task = this.active;
    if (task === null) return null;
    this.flush();
    this.active = null;
    this.log.event(`task failed: ${task.failure}`);
    if (task.wait !== null) {
      task.wait.clear();
      this.ctx.io.stderr(`${drawFailed(task.failure)}\n`);
    }
    if (task.spinner !== null) {
      task.spinner.error(task.failure);
      for (const line of task.tail) this.ctx.io.stderr(`${drawTaskLine(line)}\n`);
    }
    task.taskLog?.error(task.failure);
    return task.tail;
  }

  /** A path as the person reads it: `~/…` under their home directory. */
  private shownPath(path: string): string {
    const home = this.ctx.homeDir;
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  // -------------------------------------------------------------------------------------------
  // 1. Check

  private async check(): Promise<StepResult> {
    if (workerPlatformSupported(this.ctx.workerRuntime)) await this.ensureUv();
    this.begin("Checking this machine…", "This machine isn't ready for the worker");
    this.note(`$ ${this.commands.doctor()}`);
    // Before sign-in no server may be configured yet: check the one setup signs in to.
    const configured = await configuredUrl(this.ctx, this.global);
    const ctx =
      configured !== null && sameServer(configured, this.answers.url)
        ? this.ctx
        : { ...this.ctx, env: { ...this.ctx.env, PIDGEN_API_URL: this.answers.url } };
    const { checks } = await doctorChecks(ctx, this.global);
    for (const entry of checks) {
      const later = entry.status === "fail" ? fixedLater(entry.id) : undefined;
      this.note(
        `${entry.status.padEnd(4)}  ${entry.id}  ${entry.summary}${later ? ` (${later} fixes this)` : ""}`,
      );
    }
    this.workerCheck = checks.find((entry) => entry.id === "worker");

    const blocking = checks.filter(
      (entry) => entry.status === "fail" && fixedLater(entry.id) === undefined,
    );
    if (blocking.length > 0) {
      const names = blocking.map((entry) => entry.id).join(", ");
      throw new StepFailure(
        new CliError(
          "DOCTOR_FAILED",
          `${blocking.length} check${blocking.length === 1 ? "" : "s"} would fail a later step: ${names}.`,
          ExitCode.Unexpected,
          { checks },
        ),
        this.commands.doctor(),
        `${blocking.map((entry) => `${entry.id}: ${entry.fix ?? "see its summary"}`).join("; ")}.`,
      );
    }
    const warnings = checks.filter((entry) => entry.status === "warn").length;
    this.done(machineReady(this.ctx.workerRuntime.platform, checks));
    for (const entry of checks.filter(
      (check) => check.status === "warn" && warningApplies(check),
    )) {
      this.warn(entry.summary);
    }
    return {
      status: "done",
      summary: `Nothing on this machine stops setup${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`,
    };
  }

  /**
   * uv installs the worker. On `PATH`, it is used; in `~/.local/bin`, where uv's installer puts it,
   * it is used for the rest of setup though `PATH` does not have it yet. Otherwise the person is
   * asked to install it with uv's installer; declining fails with `RUNTIME_UNAVAILABLE`.
   */
  private async ensureUv(): Promise<void> {
    if ((await findOnPath(this.ctx, "uv", this.ctx.workerRuntime)) !== null) return;
    if (await this.useLocalUv()) return;
    const install = await this.prompter.confirm({
      message: "uv installs the worker and isn't on this machine. Install it?",
      footer: `Runs uv's installer: ${UV_INSTALL_COMMAND}`,
    });
    const missing = (message: string, screen: FailureScreen = {}) =>
      new StepFailure(
        new CliError("RUNTIME_UNAVAILABLE", message, ExitCode.Usage, {
          install: RUNTIME_INSTRUCTIONS,
          command: UV_INSTALL_COMMAND,
        }),
        null,
        `Install uv: \`${UV_INSTALL_COMMAND}\` (${RUNTIME_INSTRUCTIONS.wheel.url}).`,
        screen,
      );
    if (!install) {
      throw missing(
        `uv is required to install the worker and was not installed. Install it with \`${UV_INSTALL_COMMAND}\`.`,
        {
          headline: "Setup stopped: the worker needs uv.",
          lines: [`Install uv yourself: ${UV_INSTALL_COMMAND}`],
          end: `Nothing was changed. ${plainText(CONTINUE)}`,
        },
      );
    }
    this.begin("Installing uv…", "Couldn't install uv");
    this.note(`$ ${UV_INSTALL_COMMAND}`);
    const status = await this.runUvInstaller();
    if (status !== 0) {
      throw missing(`uv's installer exited with status ${status}; uv was not installed.`);
    }
    if ((await findOnPath(this.ctx, "uv", this.ctx.workerRuntime)) !== null) {
      this.done("uv installed");
      return;
    }
    if (!(await this.useLocalUv(() => this.done("uv installed")))) {
      throw missing("uv's installer finished, but setup cannot find the uv it installed.");
    }
  }

  /**
   * Uses `~/.local/bin/uv` for the rest of setup when it is there, after `found` (which ends an
   * open task), with one warning line; false when it is not.
   */
  private async useLocalUv(found: () => void = () => undefined): Promise<boolean> {
    const directory = join(this.ctx.homeDir, ".local", "bin");
    const env = { PATH: directory };
    const uv = await findOnPath({ env, cwd: this.ctx.cwd }, "uv", this.ctx.workerRuntime);
    if (uv === null) return false;
    const path = this.ctx.env["PATH"];
    this.ctx = {
      ...this.ctx,
      env: { ...this.ctx.env, PATH: path ? `${directory}${delimiter}${path}` : directory },
    };
    found();
    this.uvOffPath = true;
    this.warn(
      `Using uv at ${this.shownPath(uv)}; it is not on PATH yet: open a new terminal, or add ${this.shownPath(directory)} to PATH.`,
    );
    return true;
  }

  /**
   * Runs uv's installer as `curl -LsSf <url> | sh` does, without a command string: curl's output is
   * piped to the standard input of `sh`, the one shell the CLI starts, after the person consented.
   * What they print goes to the setup log. Returns the first non-zero exit status, else 0.
   */
  private async runUvInstaller(): Promise<number> {
    const runtime = this.ctx.workerRuntime;
    const output = collectedOutput(this.quiet.io)!;
    const options = {
      cwd: this.ctx.cwd,
      env: { HOME: this.ctx.homeDir, ...this.ctx.env },
      shell: false,
    } as const;
    const curl = runtime.spawn("curl", ["-LsSf", UV_INSTALLER_URL], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sh = runtime.spawn("sh", [], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    curl.stderr?.on("data", (chunk: Buffer) => output.write(chunk));
    sh.stdout?.on("data", (chunk: Buffer) => output.write(chunk));
    sh.stderr?.on("data", (chunk: Buffer) => output.write(chunk));
    // A shell that is gone closes its input; curl's write to it is then not an error of setup's.
    sh.stdin?.on("error", () => undefined);
    curl.once("error", () => sh.stdin?.end());
    if (curl.stdout && sh.stdin) curl.stdout.pipe(sh.stdin);
    const [fetched, ran] = await Promise.all([exitStatus(curl), exitStatus(sh)]);
    output.end();
    return fetched !== 0 ? fetched : ran;
  }

  // -------------------------------------------------------------------------------------------
  // 2. Sign in

  private async signIn(): Promise<StepResult> {
    let signedIn = await this.currentSignIn();
    let status: SetupStepStatus = "skipped";
    if (signedIn === null) {
      status = "done";
      const approved = await this.login();
      signedIn = await this.requireSignIn(approved);
      if (signedIn.me.memberships.length > 1 && this.global.account === undefined) {
        this.done(`Signed in as ${signedIn.me.user.email}`);
        signedIn = await this.chooseAccount(signedIn);
      } else {
        this.done(this.signedInLine(signedIn));
      }
    } else {
      this.note(
        `Signed in to ${this.answers.url} for ${signedIn.target.account}; skipping sign-in.`,
      );
    }
    this.signedIn = signedIn;
    this.log.secret(signedIn.target.token);

    const enroll = this.describePermission(signedIn);
    const survey = await this.takeSurvey();
    if (!signedIn.permission.allowed && survey.enrolled === null) {
      // Nothing is installed for a worker this credential cannot add.
      if (status === "skipped") this.answered(this.signedInLine(signedIn));
      throw this.cannotEnroll(signedIn, enroll);
    }
    await this.reportDone(survey, status === "skipped");
    return {
      status,
      summary: `Signed in as ${signedIn.me.user.email} for ${signedIn.target.account}.`,
      account: signedIn.target.account,
      enroll,
    };
  }

  /** "Signed in as sam@example.com · Acme · Administrator". */
  private signedInLine({ me, target, permission }: SignedIn): string {
    const membership = me.memberships.find((entry) => entry.account_id === target.account);
    const role = permission.role ?? membership?.role ?? null;
    return [
      `Signed in as ${me.user.email}`,
      membership?.account_name ?? target.account ?? "no Account",
      ...(role !== null ? [role[0]!.toUpperCase() + role.slice(1)] : []),
    ].join(" · ");
  }

  /** The profile's credential for the server, when `GET /me` accepts it. */
  private async currentSignIn(): Promise<SignedIn | null> {
    const config = await loadConfig(this.ctx);
    const target = resolveTarget(this.ctx, config, this.global);
    if (!sameServer(target.url, this.answers.url) || target.token === null) return null;
    try {
      const { me } = await readMe(this.ctx, target.url, target.token, this.global);
      const kind = targetCredentialKind(this.ctx, target, config.profiles[target.profile]);
      return { target, me, permission: enrollPermission(me, target.account, kind) };
    } catch (error) {
      const refused = error instanceof CliError && error.exitCode === ExitCode.Auth;
      if (!refused) throw error;
      if (this.ctx.env["PIDGEN_TOKEN"] !== undefined) {
        throw new StepFailure(
          error,
          null,
          "PIDGEN_TOKEN is set and the server refuses it: set it to a valid token, or unset it to sign in with a device code.",
        );
      }
      return null;
    }
  }

  /**
   * Device-code login; the Account is chosen when the login is approved. Returns that Account. The
   * sign-in block leads with the link that carries the code, then the address and the code; the
   * sign-in wait polls for the approval and answers keys (`awaitApproval`), and the caller ends it.
   */
  private async login(): Promise<string> {
    // A device-code login chooses its Account when it is approved, so --account is not passed.
    const global: GlobalOptions = {
      format: this.global.format,
      timeoutSeconds: this.global.timeoutSeconds,
      ...(this.global.profile !== undefined ? { profile: this.global.profile } : {}),
    };
    const url = this.answers.url;
    const login: CommandSpec = {
      path: ["auth", "login"],
      summary: "Sign in with a device code",
      run: (ctx, input) =>
        loginWithDeviceCode(ctx, url, input.global, undefined, (start) =>
          this.awaitApproval(start),
        ),
    };
    const data = (await this.runCommand(
      this.commands.login(),
      login,
      { args: [url], global },
      () => "Approve the login in the web app before the code expires.",
    )) as { account: string };
    return data.account;
  }

  /**
   * The sign-in wait: each device code's block, then a live line and the keys until the person
   * approves. Enter opens the link in the browser, n gets a new code, and Esc (or a code that
   * expired, was denied or was lost) asks what next: wait again with a new code (the default),
   * sign in with a token instead (which stops setup with that command as the fix), or quit.
   */
  private async awaitApproval(start: () => Promise<PendingDeviceLogin>): Promise<DeviceToken> {
    for (;;) {
      const pending = await start();
      if (this.interruption !== null) throw this.interruption;
      const wait = this.showDeviceCode(pending.shown);
      const outcome = await this.watch(pending, wait);
      if (outcome.kind === "approved") return outcome.token;
      this.dropTask();
      if (outcome.kind === "new") {
        this.log.event("new code asked for (n)");
        continue;
      }
      if (outcome.kind === "ended") {
        this.log.event(`sign-in not finished: ${outcome.code}`);
        this.warn(outcome.line);
      } else {
        this.log.event("sign-in wait stopped (Esc)");
      }
      const next = await this.prompter.select<NotFinished>({
        message: NOT_FINISHED,
        options: [
          { value: "retry", label: "Wait again with a new code" },
          { value: "token", label: "Sign in with a token instead" },
          { value: "quit", label: "Quit setup" },
        ],
        initialValue: "retry",
      });
      if (next === "retry") continue;
      if (next === "quit") throw new PromptCancelled();
      const command = this.commands.tokenLoginForAnyAccount();
      throw new StepFailure(
        new CliError(
          "SIGN_IN_NOT_FINISHED",
          "Sign-in wasn't finished: you chose to sign in with a Personal API Token instead.",
          ExitCode.Auth,
          { token_command: command },
        ),
        null,
        `Sign in with a Personal API Token for the Account: \`${command}\`.`,
        {
          headline: "Sign-in wasn't finished: sign in with a token instead.",
          lines: ["Sign in with a Personal API Token for the Account:", `  ${command}`],
        },
      );
    }
  }

  /** The sign-in block, then the sign-in wait, open as the task until the person approves. */
  private showDeviceCode(shown: DeviceCodeShown): Wait {
    // The code is for the person: the log never holds it.
    this.log.code(shown.user_code);
    const lines = [SYMBOL.bar, `${SYMBOL.active}  Sign in to Pidgen`];
    if (shown.verification_uri_complete.trim() !== "") {
      lines.push(
        drawTaskLine("Open this link and approve the sign-in:"),
        drawTaskLine(`  ${shown.verification_uri_complete}`),
        drawTaskLine(`Or go to ${shown.verification_uri} and enter  ${shown.user_code}`),
      );
    } else {
      lines.push(drawTaskLine(`Go to ${shown.verification_uri} and enter  ${shown.user_code}`));
    }
    this.say(lines.join("\n"));
    if (this.active !== null) this.done(this.active.title);
    this.flush();
    this.log.event(`task: ${WAITING}`);
    const wait = this.prompter.wait({ message: WAITING, keys: WAIT_KEYS });
    this.active = {
      title: WAITING,
      failure: "The sign-in wasn't approved",
      spinner: null,
      taskLog: null,
      wait,
      tail: [],
    };
    return wait;
  }

  /**
   * Polls one device code in the background while the wait answers keys. Each poll is logged with
   * its time and outcome (and "poll delayed <n>s" when it started more than twice the interval
   * after the one before), and the live line says how long setup has waited and when it last
   * checked, or that the server can't be reached.
   */
  private async watch(pending: PendingDeviceLogin, wait: Wait): Promise<WatchOutcome> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopping.signal]);
    const shownAt = this.ctx.now();
    let checked: number | null = null;
    let unreachable = false;
    const line = () => {
      const now = this.ctx.now();
      const elapsed = shortDuration(now - shownAt);
      if (unreachable) return `Can't reach ${this.answers.url}; still trying · ${elapsed}`;
      return `${WAITING} ${elapsed}${checked !== null ? ` · checked ${shortDuration(now - checked)} ago` : ""}`;
    };
    const onPoll = (report: PollReport) => {
      if (report.delayed !== null) this.log.event(`poll delayed ${report.delayed}s`);
      this.log.event(pollLine(report));
      unreachable = report.outcome === "network";
      checked = report.at;
      wait.update(line());
    };
    const ticker = setInterval(() => wait.update(line()), 1000);
    ticker.unref();
    const polling = pending.poll({ signal, onPoll }).then(
      (token) => ({ kind: "approved", token }) as const,
      (error: unknown) => ({ kind: "failed", error }) as const,
    );
    try {
      for (;;) {
        const next = await Promise.race([
          polling,
          wait.key().then((key) => ({ kind: "key", key }) as const),
        ]);
        if (next.kind === "approved") return next;
        if (next.kind === "failed") {
          if (this.interruption !== null) throw this.interruption;
          const error = next.error;
          const said =
            error instanceof CliError ? SIGN_IN_ENDED[error.code.toLowerCase()] : undefined;
          if (error instanceof CliError && said !== undefined) {
            const lost = error.details["answer_lost"] === true;
            return { kind: "ended", line: lost ? ANSWER_LOST : said, code: error.code };
          }
          throw error;
        }
        if (next.key === "enter") {
          await this.openLink(pending, wait);
          continue;
        }
        return { kind: next.key === "new" ? "new" : "escape" };
      }
    } finally {
      clearInterval(ticker);
      controller.abort();
    }
  }

  /**
   * Enter at the sign-in wait: opens the link that carries the code with the platform's opener
   * (`open` on macOS; `xdg-open`, or `wslview` under WSL, on Linux), so nobody has to select it in
   * the terminal. Without one, checks for approval at once (never sooner than the server's
   * interval after the previous check).
   */
  private async openLink(pending: PendingDeviceLogin, wait: Wait): Promise<void> {
    const link = pending.shown.verification_uri_complete.trim() || pending.shown.verification_uri;
    const opener = await this.findOpener();
    if (opener !== null) {
      try {
        const child = this.ctx.workerRuntime.spawn(opener.path, [link], {
          cwd: this.ctx.cwd,
          env: this.ctx.env,
          stdio: "ignore",
          detached: true,
        });
        child.on("error", () => undefined);
        child.unref();
        this.log.event(`opened the sign-in link with ${opener.name}`);
        return;
      } catch (error) {
        this.log.event(
          `couldn't open the sign-in link with ${opener.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      this.log.event("no browser opener on this machine; checking for approval now");
    }
    wait.update("No browser opener here: open the link yourself · checking now");
    pending.checkNow();
  }

  /** The platform's way to open a link in the browser, when it is on `PATH`. */
  private async findOpener(): Promise<{ name: string; path: string } | null> {
    const platform = this.ctx.workerRuntime.platform;
    const wsl =
      this.ctx.env["WSL_DISTRO_NAME"] !== undefined || this.ctx.env["WSL_INTEROP"] !== undefined;
    const names =
      platform === "darwin"
        ? ["open"]
        : platform === "linux"
          ? wsl
            ? ["wslview", "xdg-open"]
            : ["xdg-open"]
          : [];
    for (const name of names) {
      const path = await findOnPath(this.ctx, name, this.ctx.workerRuntime);
      if (path !== null) return { name, path };
    }
    return null;
  }

  private async requireSignIn(approved: string): Promise<SignedIn> {
    const signedIn = await this.currentSignIn();
    if (signedIn !== null) return signedIn;
    const wanted = this.global.account ?? this.ctx.env["PIDGEN_ACCOUNT"] ?? "the selected Account";
    throw new StepFailure(
      new CliError(
        "ACCOUNT_MISMATCH",
        `The login was approved for ${approved}, but setup is using ${wanted}.`,
        ExitCode.Auth,
        { approved, account: wanted },
      ),
      this.commands.login(),
      `Approve the login for ${wanted}, or run setup without --account.`,
    );
  }

  /** The Account question, asked only when the User belongs to more than one Account. */
  private async chooseAccount(signedIn: SignedIn): Promise<SignedIn> {
    const current = signedIn.target.account;
    const memberships = signedIn.me.memberships;
    const role = (name: string) => name[0]!.toUpperCase() + name.slice(1);
    const chosen = await this.prompter.select({
      message: "Which Account will this worker serve?",
      options: memberships.map((entry) => ({
        value: entry.account_id,
        label: entry.account_name,
        hint: (ENROLL_ROLES as readonly string[]).includes(entry.role)
          ? role(entry.role)
          : `${role(entry.role)} · can't enroll workers`,
      })),
      initialValue: current ?? memberships[0]!.account_id,
      collapse: (account) =>
        `Account · ${memberships.find((entry) => entry.account_id === account)?.account_name ?? account}`,
    });
    if (chosen === current) return signedIn;

    const config = await loadConfig(this.ctx);
    const profile = config.profiles[signedIn.target.profile];
    if (profile?.credentials[chosen] === undefined) {
      this.say(`Sign in again and approve the login for ${chosen}.`);
      const approved = await this.login();
      this.done(`Signed in for ${approved}`);
      if (approved !== chosen) {
        throw new StepFailure(
          new CliError(
            "ACCOUNT_MISMATCH",
            `The login was approved for ${approved}, not ${chosen}.`,
            ExitCode.Auth,
            { approved, account: chosen },
          ),
          this.commands.login(),
          `Approve the login for ${chosen}.`,
        );
      }
    }
    await this.runCommand(
      this.commands.accountUse(chosen),
      accountUse,
      { args: [chosen] },
      () => `Sign in for ${chosen} with \`${this.commands.login()}\`.`,
    );
    const after = await this.currentSignIn();
    if (after === null) {
      throw new StepFailure(
        new CliError(
          "AUTH_REQUIRED",
          `The server refuses the credential stored for ${chosen}.`,
          ExitCode.Auth,
        ),
        this.commands.login(),
        `Sign in for ${chosen} with \`${this.commands.login()}\`.`,
      );
    }
    return after;
  }

  /** Says whether the credential may enroll workers, and what to do when it may not. */
  private describePermission({ permission, target }: SignedIn): Record<string, unknown> {
    const account = permission.account ?? target.account ?? "<ACC-…>";
    const tokenCommand = this.commands.tokenLogin(account);
    const roles = ENROLL_ROLES.map((role) => role[0]!.toUpperCase() + role.slice(1)).join(" or ");
    if (permission.allowed) {
      this.note(
        `This credential may enroll workers in ${account} (${permission.role ? `role ${permission.role}; ` : ""}it holds ${ENROLL_SCOPE}).`,
      );
    } else {
      const reason =
        permission.kind === "pat"
          ? `the Personal API Token lacks ${ENROLL_SCOPE}`
          : `your role is ${permission.role ?? "unknown"}`;
      this.note(
        `This credential may not enroll workers in ${account}: ${reason}. An Account ${roles} can, or a Personal API Token with ${ENROLL_SCOPE}: ${tokenCommand}`,
      );
    }
    return {
      allowed: permission.allowed,
      account,
      kind: permission.kind,
      role: permission.role,
      scopes: permission.scopes,
      roles: [...ENROLL_ROLES],
      scope: ENROLL_SCOPE,
      token_command: tokenCommand,
    };
  }

  /**
   * Stops setup at sign-in when the credential cannot enroll workers, before anything is installed:
   * the roles that can, and the Personal API Token command.
   */
  private cannotEnroll(
    { permission, target }: SignedIn,
    enroll: Record<string, unknown>,
  ): StepFailure {
    const id = permission.account ?? target.account ?? "<ACC-…>";
    const tokenCommand = this.commands.tokenLogin(id);
    const roles = ENROLL_ROLES.map((role) => role[0]!.toUpperCase() + role.slice(1)).join(" or ");
    const pat = permission.kind === "pat";
    const why = pat
      ? `this Personal API Token can't enroll workers (it lacks ${ENROLL_SCOPE})`
      : `that needs an ${roles}`;
    return new StepFailure(
      new CliError(
        "ENROLL_NOT_PERMITTED",
        `This credential may not enroll workers in ${id}: ${pat ? `the Personal API Token lacks ${ENROLL_SCOPE}` : `an Account ${roles} can`}. Setup stopped before installing anything.`,
        ExitCode.Auth,
        enroll,
      ),
      null,
      `Ask an Account ${roles} to run setup on this machine, or sign in with a Personal API Token that has ${ENROLL_SCOPE}: \`${tokenCommand}\`.`,
      {
        headline: `You can't add workers to ${this.accountName()}: ${why}.`,
        lines: [
          `Ask ${pat ? `an ${roles}` : "one of them"} to run pidgen setup on this machine, or sign in with a`,
          "Personal API Token that can enroll workers:",
          `  ${tokenCommand}`,
        ],
        end: `Nothing was installed. ${plainText(CONTINUE)}`,
      },
    );
  }

  /** What this machine had done before this run: the install, the enrollment, the caps. */
  private async takeSurvey(): Promise<Survey> {
    const record = await this.keptInstall();
    let enrolled: string | null = null;
    try {
      const state = await this.enrollmentState();
      if (state.enrolled) enrolled = workerLabel(state.hostId, state.name);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      this.note(`Could not tell whether this machine's worker is enrolled: ${error.message}`);
    }
    let running = false;
    try {
      running = (await localWorkerStatus(this.quiet, this.ctx.workerRuntime)).running;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
    }
    const survey: Survey = { record, enrolled, running, caps: await this.currentCaps() };
    this.survey = survey;
    return survey;
  }

  /**
   * One line for what was done before this run. With every action done, "Already set up" and the
   * question of what to do now (unless `--agent`, `--sessions` or `--plan` say: change them);
   * otherwise "Already done" with the done actions, and setup continues.
   */
  private async reportDone(survey: Survey, signedInBefore: boolean): Promise<void> {
    const account = this.accountName();
    const agents = AGENT_KINDS.filter((kind) => survey.caps[kind] !== undefined);
    const { record, enrolled, running } = survey;
    if (record !== null && enrolled !== null && running && agents.length > 0) {
      this.reported = { install: true, enroll: true };
      this.setUp = true;
      this.answered(
        [
          "Already set up",
          account,
          agents.map((kind) => codingAgent(kind).name).join(", "),
          `pidgen-worker ${record.version}`,
          "running",
        ].join(" · "),
      );
      const { agents: given, sessions: counts, plans } = this.answers;
      const answered =
        given.length > 0 || Object.keys(counts).length > 0 || Object.keys(plans).length > 0;
      if (!answered) this.mode = await this.askRerun(record);
      return;
    }
    const parts: string[] = [];
    if (signedInBefore) parts.push(`signed in to ${account}`);
    if (record !== null) parts.push(`pidgen-worker ${record.version} installed`);
    if (enrolled !== null) parts.push(`enrolled as ${enrolled}`);
    if (running) parts.push("running");
    this.reported = { install: record !== null, enroll: enrolled !== null };
    if (parts.length > 0) this.answered(`Already done · ${parts.join(" · ")}`);
  }

  /** The re-run question: check everything and stop, change the agents, or update the worker. */
  private async askRerun(record: InstallRecord): Promise<RunMode> {
    this.updateTo = await this.newerRelease(record);
    const options: Array<PromptOption<RunMode>> = [
      { value: "check", label: "Check everything and stop" },
      { value: "change", label: "Change coding agents or sessions" },
    ];
    if (this.updateTo !== null) {
      options.push({ value: "update", label: `Update the worker to ${this.updateTo}` });
    }
    return this.prompter.select({
      message: "What do you want to do?",
      options,
      initialValue: "check",
    });
  }

  /**
   * The release `pidgen worker update` would install: the newest of the server's current series on
   * `record`'s track when it is newer (`resolveUpdate`, the rule update itself follows).
   */
  private async newerRelease(record: InstallRecord): Promise<string | null> {
    try {
      const { list } = await readWorkerReleases(this.ctx, this.global);
      const index = packageIndex(this.answers.test || record.index === "testpypi");
      const release = await resolveUpdate(this.ctx, selectSeries(list), index, record.version);
      this.updateLicence = list.eula.name;
      return release?.version ?? null;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      this.note(`Could not read the server's current worker release: ${error.message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // 3. Choose coding agents

  /**
   * The coding agents the worker runs: `--agent`, else the question, with the ones on `PATH`
   * pre-ticked. A chosen agent that is missing is installed with npm: ticking it (or naming it
   * with `--agent`) is the consent, so nothing more is asked.
   */
  private async chooseAgents(): Promise<StepResult> {
    if (this.mode !== "change") {
      // Checking or updating a finished setup keeps the agents its node.yaml names.
      const kinds = AGENT_KINDS.filter((kind) => this.survey?.caps[kind] !== undefined);
      this.agents = kinds.map(codingAgent);
      return {
        status: "skipped",
        summary: `The worker runs ${this.agents.map((agent) => agent.name).join(" and ")}.`,
        agents: kinds,
        installed: [],
      };
    }
    const runtime = this.ctx.workerRuntime;
    const found = new Map<AgentKind, string | null>();
    for (const agent of CODING_AGENTS) {
      found.set(agent.kind, await findAgent(this.ctx, agent, runtime));
    }
    let chosen: AgentKind[];
    if (this.answers.agents.length > 0) {
      chosen = this.answers.agents;
      this.answered(
        `Coding agents · ${chosen.map((kind) => codingAgent(kind).name).join(", ")} (from --agent)`,
      );
    } else {
      chosen = await this.askAgents(found);
    }
    if (chosen.length === 0) {
      throw new StepFailure(
        new CliError(
          "AGENT_REQUIRED",
          "No coding agent was chosen; the worker needs one to run work.",
          ExitCode.Usage,
          { agents: [...AGENT_KINDS] },
        ),
        null,
        `Tick a coding agent, or name it in advance with \`--agent\`: \`pidgen setup --agent ${AGENT_KINDS[0]}\` (repeat \`--agent\` for more than one).`,
      );
    }
    const installed: AgentKind[] = [];
    for (const kind of chosen) {
      if (found.get(kind) !== null) continue;
      await this.installAgent(codingAgent(kind));
      installed.push(kind);
    }
    this.agents = chosen.map(codingAgent);
    const names = this.agents.map((agent) => agent.name).join(" and ");
    return {
      status: "done",
      summary: `The worker runs ${names}${installed.length > 0 ? `; setup installed ${installed.map((kind) => codingAgent(kind).name).join(" and ")}` : ""}.`,
      agents: chosen,
      installed,
    };
  }

  /**
   * The coding agents question: a multiselect of the agents setup installs, the ones on `PATH`
   * ticked, and each harness the worker runs that setup does not manage (Pi), shown disabled when
   * it is on `PATH`. Confirming none keeps it open.
   */
  private async askAgents(found: ReadonlyMap<AgentKind, string | null>): Promise<AgentKind[]> {
    const options: Array<PromptOption<string>> = CODING_AGENTS.map((agent) => ({
      value: agent.kind,
      label: agent.name,
      hint:
        found.get(agent.kind) !== null
          ? "on this machine"
          : "not installed · setup installs it with npm",
    }));
    for (const shown of SHOWN_ONLY_AGENTS) {
      if ((await findOnPath(this.ctx, shown.command, this.ctx.workerRuntime)) === null) continue;
      options.push({
        value: shown.kind,
        label: shown.name,
        hint: "on this machine · the worker runs it; setup doesn't manage it",
        disabled: true,
      });
    }
    const chosen = await this.prompter.multiselect({
      message: "Which coding agents will this worker run?",
      options,
      initialValues: CODING_AGENTS.filter((agent) => found.get(agent.kind) !== null).map(
        (agent) => agent.kind,
      ),
      required: "Choose at least one.",
      footer: "↑/↓ move · space select · enter confirm",
      collapse: (values) =>
        `Coding agents · ${options
          .filter((option) => values.includes(option.value))
          .map((option) => option.label)
          .join(", ")}`,
    });
    return AGENT_KINDS.filter((kind) => chosen.includes(kind));
  }

  /**
   * Installs a missing agent with `npm install -g <package>`. When npm may not write its global
   * directory (EACCES), the person runs the command, and setup looks on `PATH` again once they say
   * it finished.
   */
  private async installAgent(agent: CodingAgent): Promise<void> {
    const install = agentInstallCommand(agent);
    const missing = (message: string) =>
      new StepFailure(
        agentNotFound(agent, message),
        install,
        `Install ${agent.name}: \`${install}\`.`,
      );
    this.begin(`Installing ${agent.name}…`, `Couldn't install ${agent.name}`);
    this.note(`$ ${install}`);
    const { status, output } = await this.runNpm(agent);
    if (status !== 0) {
      if (!/EACCES/.test(output)) {
        throw new StepFailure(
          new CliError(
            "INSTALL_FAILED",
            `npm exited with status ${status}; ${agent.name} was not installed.`,
            ExitCode.Unexpected,
            { harness: agent.kind, command: install, status },
          ),
          install,
          `Read npm's output (its last lines above, all of it in the setup log) and fix what it names, or install it yourself: \`${install}\`.`,
        );
      }
      this.progress(
        `npm may not install ${agent.name} here`,
        `npm can't install ${agent.name} here`,
      );
      this.failTask();
      this.say(
        [
          `npm may not write to its global directory (EACCES), so setup cannot install ${agent.name}.`,
          "Run this yourself in another terminal (with sudo, or after pointing npm's prefix at a directory you own):",
          `  ${install}`,
        ].join("\n"),
      );
      const finished = await this.prompter.confirm({
        message: `Has \`${install}\` finished?`,
        active: "Yes, it's installed",
        inactive: "No, stop setup",
      });
      if (!finished)
        throw missing(`${agent.name} was not installed. Install it with \`${install}\`.`);
    }
    if ((await findAgent(this.ctx, agent, this.ctx.workerRuntime)) === null) {
      throw missing(
        `${agent.name} (${agent.command}) is still not on PATH. Install it with \`${install}\`, and put npm's global bin directory (\`npm prefix -g\`/bin) on PATH.`,
      );
    }
    if (this.active !== null) this.done(`${agent.name} installed`);
    else this.answered(`${agent.name} installed`);
  }

  /** Runs `npm install -g <package>`: its output goes to the setup log and is kept. */
  private runNpm(agent: CodingAgent): Promise<{ status: number; output: string }> {
    const collected = collectedOutput(this.quiet.io)!;
    const child = this.ctx.workerRuntime.spawn("npm", agentInstallArgs(agent), {
      cwd: this.ctx.cwd,
      env: agentEnvironment(this.ctx),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const output: string[] = [];
    const take = (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      collected.write(chunk);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    return exitStatus(child).then((status) => {
      collected.end();
      return { status, output: output.join("") };
    });
  }

  // -------------------------------------------------------------------------------------------
  // 4. Sign in to coding agents

  /**
   * Asks each chosen agent's status command first, then runs `pidgen worker login <agent>` only for
   * those not signed in; an agent that cannot say is signed in only when the person asks.
   */
  private async signInAgents(): Promise<StepResult> {
    const runtime = this.ctx.workerRuntime;
    const logins: Partial<Record<AgentKind, AgentLogin>> = {};
    for (const agent of this.agents) {
      const executable = await findAgent(this.ctx, agent, runtime);
      if (executable === null)
        throw new StepFailure(
          agentNotFound(agent),
          null,
          `Install ${agent.name}: \`${agentInstallCommand(agent)}\`.`,
        );
      const login = await agentStatus(this.ctx, executable, agent, runtime);
      logins[agent.kind] = login;
      this.note(`${agent.name}: ${login}`);
      // A finished setup's agents were signed in before: only a change is said.
      if (login === "ready" && this.mode === "change") this.answered(`${agent.name} signed in`);
    }
    let ran = false;
    for (const agent of this.agents) {
      const login = logins[agent.kind];
      if (login === "ready") continue;
      if (login === "unknown") {
        const now = await this.prompter.confirm({
          message: `Setup can't tell whether ${agent.name} is signed in. Sign in now?`,
          inactive: "No, it's signed in",
          initialValue: false,
        });
        if (!now) continue;
      } else {
        await this.prompter.select({
          message: `${agent.name} needs you to sign in. Its own sign-in runs here; setup continues after it.`,
          options: [{ value: true, label: "Press Enter to start" }],
          collapse: () => `${agent.name} · signing in`,
        });
      }
      const data = (await this.runCommand(
        this.commands.agentLogin(agent.kind),
        workerLogin,
        { args: [agent.kind] },
        (error) => {
          const fix = error.details["fix"];
          return typeof fix === "string" ? fix : "Fix the error.";
        },
      )) as { login: AgentLogin };
      logins[agent.kind] = data.login;
      if (data.login === "ready") this.answered(`${agent.name} signed in`);
      ran = true;
    }
    const pending = this.agents.filter((agent) => logins[agent.kind] !== "ready");
    return {
      status: ran ? "done" : "skipped",
      summary:
        pending.length === 0
          ? ran
            ? `Signed in to ${this.agents.map((agent) => agent.name).join(" and ")}.`
            : "All chosen coding agents are signed in."
          : `Setup cannot tell whether ${pending.map((agent) => agent.name).join(" and ")} ${pending.length === 1 ? "is" : "are"} signed in: run ${pending.map((agent) => `\`${this.commands.agentLogin(agent.kind)}\``).join(" and ")} if not.`,
      logins,
    };
  }

  // -------------------------------------------------------------------------------------------
  // 5. Size coding agent sessions

  /**
   * Asks how many sessions each chosen agent runs at once (`--sessions` or `--plan` answer in
   * advance). The enroll step applies the caps once `node.yaml` exists.
   */
  private async sizeAgents(): Promise<StepResult> {
    const plans: Partial<Record<AgentKind, string>> = {};
    const caps = new Map<AgentKind, number>();
    const current = await this.currentCaps();
    if (this.mode !== "change") {
      // Checking or updating keeps the caps; they are not applied again.
      for (const agent of this.agents) caps.set(agent.kind, current[agent.kind]!);
      return {
        status: "skipped",
        summary: `${this.agents.map((agent) => `${agent.name} runs up to ${sessions(caps.get(agent.kind)!)}`).join("; ")}.`,
        plans,
        caps: Object.fromEntries(caps),
      };
    }
    for (const agent of this.agents) {
      const plan = this.answers.plans[agent.kind];
      const given = this.answers.sessions[agent.kind];
      let cap: number;
      if (given !== undefined) {
        cap = given;
        this.answered(`${agent.name} · ${sessions(cap)} (from --sessions)`);
      } else if (plan !== undefined) {
        cap = findPlan(agent.kind, plan)!.cap;
        plans[agent.kind] = plan;
        this.answered(`${agent.name} · ${sessions(cap)} (from --plan)`);
      } else {
        cap = await this.askSessions(agent, current[agent.kind]);
      }
      caps.set(agent.kind, cap);
    }
    this.caps = caps;
    return {
      status: "done",
      summary: `${this.agents.map((agent) => `${agent.name} runs up to ${sessions(caps.get(agent.kind)!)}`).join("; ")}.`,
      plans,
      caps: Object.fromEntries(caps),
    };
  }

  /**
   * The sessions question: the numbers the agent's plans suggest, each with its plans as the hint,
   * then Custom (a whole number from 1). It starts on `current`, the worker's cap on a re-run, else
   * on the lowest.
   */
  private async askSessions(agent: CodingAgent, current: number | undefined): Promise<number> {
    const options: Array<PromptOption<number | "custom">> = SESSION_HINTS[agent.kind].map(
      (entry) => ({ value: entry.sessions, label: String(entry.sessions), hint: entry.hint }),
    );
    if (current !== undefined && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: String(current), hint: "this worker's current cap" });
      options.sort((a, b) => Number(a.value) - Number(b.value));
    }
    options.push({ value: "custom", label: "Custom…" });
    const collapse = (count: number) => `${agent.name} · ${sessions(count)}`;
    const answer = await this.prompter.select({
      message: `${agent.name}: how many sessions should run at once?`,
      options,
      initialValue:
        current ?? Math.min(...SESSION_HINTS[agent.kind].map((entry) => entry.sessions)),
      footer: `Change it later: pidgen-worker capacity set ${agent.kind} --max <n>`,
      collapse: (value) => (value === "custom" ? `${agent.name} · Custom…` : collapse(value)),
    });
    if (answer !== "custom") return answer;
    const typed = await this.prompter.text({
      message: `${agent.name} sessions at a time`,
      validate: (value) =>
        wholeSessions(value) === null ? "Enter a whole number, 1 or more." : undefined,
      collapse: (value) => collapse(wholeSessions(value)!),
    });
    return wholeSessions(typed)!;
  }

  /** Each coding agent's cap in the worker's `node.yaml` (from 1), when there is one. */
  private async currentCaps(): Promise<Partial<Record<AgentKind, number>>> {
    let text: string;
    try {
      text = await readFile(join(resolvePidgenHome(this.ctx), "config", "node.yaml"), "utf8");
    } catch {
      return {};
    }
    const caps: Partial<Record<AgentKind, number>> = {};
    try {
      const harnesses = (parseYaml(text) as { harnesses?: Record<string, { max?: unknown }> })
        ?.harnesses;
      for (const kind of AGENT_KINDS) {
        const max = harnesses?.[kind]?.max;
        if (typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= SESSIONS_MAX) {
          caps[kind] = max;
        }
      }
    } catch {
      // A node.yaml setup cannot read leaves the questions on their lowest answer.
    }
    return caps;
  }

  /**
   * Applies the caps the capacity step chose with `pidgen-worker capacity set`: each chosen agent's,
   * `--max 0` for every other harness, then the prompt pool. Exit 0 with a "saved", "saved (…)",
   * "saved, apply pending" or "saved; …" line is success, wherever the line falls: the worker
   * prints the file's path and digest before it. Exit 1 (a refused edit) or anything else fails the
   * step.
   */
  private async applyCaps(ctx: RunContext, caps: Map<AgentKind, number>): Promise<Caps> {
    const applied: Caps = {};
    for (const args of capacityArgs(caps)) {
      const command = capacityCommand(args);
      this.note(`$ ${command}`);
      let result: { status: number; output: string };
      try {
        result = await runWorkerCapacity(ctx, args, ctx.workerRuntime);
      } catch (error) {
        if (error instanceof CliError) {
          throw new StepFailure(error, command, "Install the worker: `pidgen worker install`.");
        }
        throw error;
      }
      const output = result.output.trim();
      if (output !== "") this.note(output);
      const saved = output
        .split("\n")
        .map((line) => line.trim())
        .some(
          (line) =>
            line === "saved" ||
            line === "saved, apply pending" ||
            line.startsWith("saved; ") ||
            line.startsWith("saved ("),
        );
      if (result.status !== 0 || !saved) {
        const refused = result.status === 1;
        throw new StepFailure(
          new CliError(
            refused ? "CAPACITY_REFUSED" : "CAPACITY_FAILED",
            `\`${command}\` ${refused ? "refused the edit" : `exited with status ${result.status}`}: ${output || "(no output)"}`,
            ExitCode.Unexpected,
            { command, status: result.status, output },
          ),
          command,
          refused
            ? "Fix what the worker names, then run the command again or run setup again."
            : "Read the worker's output in the setup log; check the installed worker with `pidgen worker verify`.",
        );
      }
      applied[args[1]!] = Number(args.at(-1));
    }
    return applied;
  }

  // -------------------------------------------------------------------------------------------
  // 6. Choose a runtime

  /**
   * The install record when setup keeps that install: the form and version asked for (any, unless
   * `--runtime` or `--version` say), and a worker the machine check did not fail.
   */
  private async keptInstall(): Promise<InstallRecord | null> {
    let record: InstallRecord | null;
    try {
      record = await readInstallRecord(this.ctx);
    } catch (error) {
      if (error instanceof CliError) return null;
      throw error;
    }
    const { runtime, version } = this.answers;
    const kept =
      record !== null &&
      (runtime === undefined || record.form === runtime) &&
      (version !== undefined ? record.version === version : this.workerCheck?.status !== "fail");
    return kept ? record : null;
  }

  private async chooseRuntime(): Promise<StepResult> {
    const record = await readInstallRecord(this.ctx);
    const { runtime } = this.answers;
    this.skipInstall = (await this.keptInstall()) !== null;
    if (this.skipInstall && record !== null) {
      this.form = record.form;
      return {
        status: "skipped",
        summary: `pidgen-worker ${record.version} is installed as a ${record.form}.`,
        runtime: record.form,
      };
    }
    if (runtime !== undefined) {
      this.form = runtime;
      return { status: "done", summary: `--runtime ${runtime} answered the question.`, runtime };
    }

    const available = await this.availableForms();
    if (available.length === 0) {
      throw new StepFailure(
        new CliError(
          "RUNTIME_UNAVAILABLE",
          "uv is required to install the worker and was not found on PATH.",
          ExitCode.Usage,
          { install: RUNTIME_INSTRUCTIONS, command: UV_INSTALL_COMMAND },
        ),
        null,
        `Install uv: \`${UV_INSTALL_COMMAND}\`.`,
      );
    }
    if (available.length === 1) {
      // While setup offers one form, nothing is asked.
      this.form = available[0]!;
      return {
        status: "done",
        summary: `The ${this.form} runtime is the one setup installs.`,
        runtime: this.form,
      };
    }
    const fallback = record?.form ?? available[0]!;
    this.form = await this.prompter.select({
      message: "Which worker runtime will this machine run?",
      options: available.map((form) => ({ value: form, label: form })),
      initialValue: fallback,
      collapse: (form) => `Worker runtime · ${form}`,
    });
    return { status: "done", summary: `The ${this.form} runtime was chosen.`, runtime: this.form };
  }

  /** The forms this machine can install: `uv` means `wheel`. */
  private async availableForms(): Promise<WorkerForm[]> {
    const uv = await findOnPath(this.ctx, "uv", this.ctx.workerRuntime);
    return SETUP_FORMS.filter((form) => form === "wheel" && uv !== null);
  }

  // -------------------------------------------------------------------------------------------
  // 4. Install and verify

  private async install(): Promise<StepResult> {
    if (this.mode === "update" && this.updateTo !== null) return this.update(this.updateTo);
    if (this.skipInstall) {
      const record = await readInstallRecord(this.ctx);
      if (this.mode === "check" && this.updateTo !== null) {
        // Checking reports the newer release; it asks nothing and installs nothing.
        this.answered(
          `pidgen-worker ${this.updateTo} is available (${record?.version} installed) · update with ${this.commands.pidgen(["worker", "update"], { account: false })}`,
        );
      } else if (record !== null && this.offersUpdate()) {
        const newer = await this.newerRelease(record);
        if (newer !== null && (await this.confirmUpdate(newer, record.version))) {
          return this.update(newer);
        }
      }
      this.note("The worker is installed; skipping the install.");
      if (!this.reported.install) this.answered(`pidgen-worker ${record?.version} is installed`);
      return { status: "skipped", summary: `pidgen-worker ${record?.version} is installed.` };
    }
    if (this.form === "wheel") await this.warnSharedWorker();
    const command = this.commands.install(this.form);
    const installed = (await this.runCommand(
      command,
      this.installSpec(command),
      {},
      installFix,
      this.quiet,
      null,
    )) as InstallRecord;
    const verifying = "Verifying it was published by Pidgen's release workflow…";
    const unverified = `pidgen-worker ${installed.version} didn't verify`;
    if (this.active === null) this.begin(verifying, unverified);
    else this.progress(verifying, unverified);
    const verified = (await this.runCommand(
      this.commands.verify(),
      workerVerify,
      {},
      () => "Reinstall it with `pidgen worker install --force`.",
    )) as { checks: DoctorCheck[] };
    for (const entry of verified.checks) {
      this.note(`${entry.status.padEnd(4)}  ${entry.id}  ${entry.summary}`);
    }
    this.done(`pidgen-worker ${installed.version} installed and verified`);
    return {
      status: "done",
      summary: `pidgen-worker ${installed.version} is installed and verified (${installed.digest}).`,
      version: installed.version,
    };
  }

  /**
   * Whether the install step offers a newer release before the worker is started: on every run
   * but a finished machine's re-run (its menu offers the update) and one `--version` pins.
   */
  private offersUpdate(): boolean {
    return this.mode === "change" && !this.setUp && this.answers.version === undefined;
  }

  /**
   * The update question, default yes, asked once before the worker is started (`--accept-licence`
   * answers it), then, on yes, the install question for the newer release, since a new release
   * may carry a new licence. No, to either, keeps the installed release and says how to update it
   * later.
   */
  private async confirmUpdate(newer: string, installed: string): Promise<boolean> {
    this.note(`pidgen-worker ${newer} is newer than the installed ${installed}.`);
    const message = `pidgen-worker ${newer} is available (${installed} installed). Update before starting?`;
    let yes: boolean;
    if (this.answers.acceptLicence) {
      this.answered(`${message} · Yes (from --accept-licence)`);
      yes = true;
    } else {
      yes = await this.prompter.confirm({ message });
    }
    if (yes) {
      try {
        await this.confirmInstall(newer, this.updateLicence ?? "worker's end-user licence");
        return true;
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "SETUP_CANCELLED") throw error;
        this.log.event(`licence of ${newer} not accepted; keeping ${installed}`);
      }
    }
    const update = this.commands.pidgen(["worker", "update"], { account: false });
    this.reported.install = true;
    this.answered(`pidgen-worker ${installed} is installed · update it later with ${update}`);
    return false;
  }

  /**
   * The update: `pidgen worker update --restart`, verified as an install is, and a running worker
   * restarted on it (one not running is started by the enroll step). Choosing the update in the
   * re-run question, or yes to the update question and its licence, is the consent.
   */
  private async update(version: string): Promise<StepResult> {
    const record = await readInstallRecord(this.ctx);
    const test = this.answers.test || record?.index === "testpypi";
    const command = this.commands.pidgen([
      "worker",
      "update",
      "--restart",
      ...(test ? ["--test"] : []),
    ]);
    this.begin(
      `Updating pidgen-worker to ${version}…`,
      `Couldn't update pidgen-worker to ${version}`,
    );
    const updated = (await this.runCommand(
      command,
      workerUpdate,
      { options: { restart: true, test } },
      (error) =>
        error.code === "UPDATE_ROLLED_BACK"
          ? "The new release didn't start, so the previous one runs again; read the worker's log."
          : "Read the output in the setup log and fix what it names.",
    )) as InstallRecord & { previous_version: string; restarted: boolean };
    this.done(
      `pidgen-worker ${updated.version} installed, verified${updated.restarted ? " and running" : ""}`,
    );
    return {
      status: "done",
      summary: `pidgen-worker ${updated.previous_version} was updated to ${updated.version}${updated.restarted ? " and restarted" : ""}.`,
      command,
      version: updated.version,
    };
  }

  /**
   * `pidgen worker install` as setup runs it: once the release is chosen, and before anything is
   * downloaded or run, the one install question (install pidgen-worker <version> and accept its
   * licence; `--accept-licence` answers it), then the command's line. The licence notice is not
   * printed again. Declining stops setup with `SETUP_CANCELLED`: the person stopped it.
   */
  private installSpec(command: string): CommandSpec {
    return {
      path: ["worker", "install"],
      summary: "Install the worker",
      configure: () => undefined,
      run: async (ctx, { global }) => {
        assertSupportedPlatform(ctx.workerRuntime);
        const { record, installed, meta } = await installWorker(ctx, global, {
          runtime: this.form,
          version: this.answers.version,
          test: this.answers.test,
          force: false,
          printLicence: false,
          beforeInstall: async (release, list) => {
            await this.confirmInstall(release.version, list.eula.name);
            this.begin(
              `Installing pidgen-worker ${release.version}…`,
              `Couldn't install pidgen-worker ${release.version}`,
            );
            this.note(`$ ${command}`);
          },
        });
        return { data: { ...record, installed }, meta };
      },
    };
  }

  /**
   * The install question: one confirm for the install and the licence it accepts, naming the
   * licence and linking its full text. Answered with `--accept-licence`, the screen shows the one
   * answered line; the log records the licence's lines under it either way.
   */
  private async confirmInstall(version: string, licence: string): Promise<void> {
    const message = `Install pidgen-worker ${version} and accept its licence?`;
    const detail = [`The worker is proprietary software under the ${licence}.`, WORKER_EULA_LINK];
    if (this.answers.acceptLicence) {
      this.answered(`${message} · Yes (from --accept-licence)`);
      for (const line of detail) this.log.line(`  ${line}`);
      return;
    }
    const yes = await this.prompter.confirm({ message, detail: detail.join("\n") });
    if (yes) return;
    throw new CliError(
      "SETUP_CANCELLED",
      `The licence wasn't accepted, so the worker wasn't installed.`,
      ExitCode.Usage,
      { version, licence },
    );
  }

  /**
   * One warning line when uv's shared tool slot holds a `pidgen-worker` the install record does not
   * name: setup installs its own copy in the worker home and leaves that one alone.
   */
  private async warnSharedWorker(): Promise<void> {
    const shared = await sharedUvWorker(this.quiet);
    if (shared === null) return;
    const record = await readInstallRecord(this.ctx);
    if (record !== null && record.location === shared.location) return;
    const shown = this.shownPath(resolvePidgenHome(this.ctx));
    this.warn(
      `Another pidgen-worker ${shared.version} is installed with uv (${shared.location}); setup installs its own copy in ${shown} and leaves that one alone.`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // 5. Enroll and start

  /**
   * Enrolls this install's worker unless it is enrolled, applies the caps, and starts it. It is
   * enrolled only when this install's worker home holds a credential (`worker.env` with
   * `PIDGEN_NODE_TOKEN`) for the configured server, and `GET /workers` lists the id it names
   * (`PIDGEN_LOCALITY_DOMAIN`) unrevoked; a worker listed under this host's name that is not this
   * install's is never adopted. A worker whose home holds no credential is never started.
   *
   * A worker has an id the App Service mints (`host_id`, `wkr_…`) and the name the person chose
   * (`display_name`). After enrolling, the new worker's id is the one `worker.env` saved; setup
   * waits for that id to be connected.
   */
  private async enrollAndStart(): Promise<StepResult> {
    const c = this.commands;
    const ctx = this.quiet;

    const state = await this.enrollmentState();
    const { read, enrolled, revoked, foreign, mine } = state;
    const local = await localWorkerStatus(ctx, ctx.workerRuntime);
    let id = state.hostId;
    let name = state.name;
    let enroll = c.enroll(name);
    let ran = false;

    if (enrolled) {
      const shown = workerLabel(id, name);
      this.note(`${shown} is enrolled; skipping the enrollment.`);
      if (!this.reported.enroll) this.answered(`${shown} is enrolled in ${this.accountName()}`);
    } else {
      const permission = this.signedIn?.permission;
      if (permission !== undefined && !permission.allowed) {
        const account = permission.account ?? "<ACC-…>";
        throw new StepFailure(
          new CliError(
            "ENROLL_NOT_PERMITTED",
            `This credential may not enroll workers in ${account}; nothing was enrolled.`,
            ExitCode.Auth,
            { account, role: permission.role, roles: [...ENROLL_ROLES], scope: ENROLL_SCOPE },
          ),
          enroll,
          `Ask an Account Owner or Administrator to run setup, or sign in with a Personal API Token that has ${ENROLL_SCOPE}: \`${c.tokenLogin(account)}\`.`,
        );
      }
      // pidgen-worker keeps a saved credential and ignores a new enrollment: never create one then.
      if (foreign !== null) throw this.foreignCredential(foreign, enroll);
      if (revoked) await this.confirmEnrollAgain(enroll);
      // This install's newest worker, by its install id, is preferred: when it is listed live
      // without a credential here, the person decides whether to replace it before anything is
      // created; when it is listed removed, its name is the suggestion.
      let list = read.list;
      let preferred: Preferred | null = revoked
        ? { name, why: "this machine's removed worker's name", listedRemoved: true }
        : null;
      let kept: string | null = null;
      if (mine !== null && !this.answers.labelGiven) {
        const mineName = workerName(mine);
        if (mine.revoked_at !== null) {
          preferred = {
            name: mineName,
            why: "this install's removed worker's name",
            listedRemoved: true,
          };
        } else {
          const replaced = await this.replaceListed(mineName);
          if (replaced === null) {
            kept = mineName;
          } else {
            list = replaced;
            preferred = {
              name: mineName,
              why: "this install's worker, removed to be replaced",
              listedRemoved: false,
            };
          }
        }
      }
      // The name is asked before anything is created, with a suggestion filled in.
      name = await this.chooseName(list, preferred, kept);
      this.begin(`Enrolling as ${name}…`, `Couldn't enroll ${name}`);
      // A removed worker's credential is moved aside, so the worker redeems the new enrollment.
      const result = await this.enrollUnderFreeName(ctx, list, name, revoked);
      name = result.name;
      enroll = c.enroll(name, revoked);
      if (result.replaced !== null) {
        this.note(`Moved the removed worker's credential aside to ${result.replaced}.`);
      }
      // The worker saved the id the App Service gave it, and authenticates as it.
      id = (await readWorkerCredential(ctx)).hostId;
      if (id === null) {
        this.note(`worker.env names no id for ${name}; setup looks for it by its name.`);
      }
      this.done(`Enrolled as ${workerLabel(id, name)} in ${this.accountName()}`);
      ran = true;
    }

    this.begin(
      local.running && this.caps === null ? "Checking the worker…" : "Starting the worker…",
      "Couldn't set the worker's sessions",
    );
    // node.yaml exists once the worker is enrolled; a running manager applies the edit itself.
    const capacity = this.caps !== null ? await this.applyCaps(ctx, this.caps) : null;
    if (capacity !== null) ran = true;

    if (this.active !== null) this.active.failure = "The worker didn't start";
    if (local.running && local.record !== null) {
      this.note(`pidgen-worker is already running (pid ${local.record.pid}); skipping the start.`);
    } else {
      await this.requireCredential(ctx, enroll);
      await this.runCommand(
        c.start(),
        workerStart,
        { options: { detach: true } },
        (error) =>
          error.code === "WORKER_EXITED"
            ? "Read error.details.log_tail and the worker's log, and fix what it names."
            : "Fix the error.",
        ctx,
      );
      ran = true;
    }

    const wait = await this.waitConnected(read, ctx, { id, name });
    const connected = wait.connected;
    id = wait.id;
    const shown = workerLabel(id, name);
    this.done(
      connected === true
        ? `Worker running and connected to Pidgen as ${shown}`
        : "Worker running · this credential can't confirm it connected",
    );
    return {
      status: ran ? "done" : "skipped",
      summary:
        connected === true
          ? `${shown} is enrolled, running, and connected to the App Service.`
          : `${shown} is enrolled and running. This credential cannot read GET /workers (${read.refused?.code ?? "refused"}), so setup cannot confirm it connected: run \`${c.status()}\` signed in as an Account Owner or Administrator.`,
      // The enroll command names the worker's name, which is known only now.
      command: `${enroll} && ${c.start()}`,
      host_id: id,
      display_name: name,
      connected,
      ...(capacity !== null ? { capacity } : {}),
    };
  }

  /**
   * Whether this install's worker is enrolled: its worker home holds a credential (`worker.env`
   * with `PIDGEN_NODE_TOKEN`) for the configured server, and `GET /workers` lists its host id
   * unrevoked (a credential that cannot read the list leaves the local credential to decide).
   * A credential for this server that the list does not show live (revoked, or not listed at all)
   * is `revoked`: the worker was removed. A credential for another server is `foreign`.
   *
   * `mine` is this install's newest worker the list names: the newest whose `install_id` is the
   * one the worker home's `install-id` holds (made now when there is none). It is how setup knows
   * this install's worker when `worker.env` is gone.
   *
   * `hostId` is the id `worker.env` names when it holds a credential for this server, else `null`;
   * `name` is that worker's name as listed (`display_name`, or its id for a worker enrolled before
   * names), else `--label` or this host's name.
   */
  private async enrollmentState(): Promise<{
    read: WorkersRead;
    enrolled: boolean;
    revoked: boolean;
    foreign: WorkerCredential | null;
    mine: WorkerResource | null;
    hostId: string | null;
    name: string;
  }> {
    const home = await readWorkerCredential(this.quiet);
    const ours =
      home.credential && home.serviceUrl !== null && sameServer(home.serviceUrl, this.answers.url);
    const foreign = home.credential && !ours ? home : null;
    const install = await ensureInstallId(this.ctx);
    if (install.created) this.note(`Made this install's id in ${install.path}.`);
    if (install.invalid) this.note(invalidInstallIdNote(install.path));
    const read = await this.readWorkers();
    const hostId = ours && home.hostId !== null ? home.hostId : null;
    if (read.list === null) {
      const name = hostId ?? this.answers.label;
      return { read, enrolled: ours, revoked: false, foreign, mine: null, hostId, name };
    }
    const view = hostId !== null ? serverView(read.list, hostId) : null;
    const enrolled = view?.enrolled === true;
    const name = view?.worker ? workerName(view.worker) : (hostId ?? this.answers.label);
    const mine = install.id === null ? null : newestOfInstall(read.list, install.id);
    return { read, enrolled, revoked: ours && !enrolled, foreign, mine, hostId, name };
  }

  /**
   * This install's worker `name` is listed live, but this home holds no credential for it: setup
   * says so and asks whether to replace it, instead of enrolling a second worker beside it. Yes:
   * the person removes it on the Workers page, and setup reads the list again each time they say
   * it is done, until it no longer lists it live; it answers that list. No (at either question):
   * `null`, and setup suggests a new name.
   */
  private async replaceListed(name: string): Promise<WorkerList | null> {
    const account = this.accountName();
    this.warn(`This install's worker ${name} is still listed but its credential is missing.`);
    this.note(
      `${name} is this install's worker (its install id matches), listed live in ${account}; this worker home holds no credential for it.`,
    );
    const replace = await this.prompter.confirm({
      message: `Replace ${name}?`,
      detail: `Yes: remove it on the Workers page, then setup enrolls this install as ${name} again.\nNo: enroll this install under a new name.`,
    });
    if (!replace) {
      this.note(`Not replacing ${name}: enrolling this install under a new name.`);
      return null;
    }
    this.say(
      `${SYMBOL.bar}\n${SYMBOL.bar}  Remove ${name} on the Workers page in Pidgen. Setup continues under that name once Pidgen lists it as removed.`,
    );
    for (;;) {
      const removed = await this.prompter.confirm({
        message: `Removed ${name} on the Workers page?`,
        detail:
          "Setup reads Pidgen's list of workers again.\nNo: enroll this install under a new name instead.",
      });
      if (!removed) {
        this.note(`${name} was not removed: enrolling this install under a new name.`);
        return null;
      }
      const read = await this.readWorkers();
      if (read.list === null) return null;
      if (liveWorker(read.list, name) === undefined) {
        this.note(`${name} is listed as removed; enrolling this install under its name.`);
        return read.list;
      }
      this.warn(`${name} is still listed live in ${account}: remove it on the Workers page first.`);
    }
  }

  /**
   * `WORKER_CREDENTIAL_PRESENT`: the worker home holds a credential for another server (or one
   * that names none). pidgen-worker would keep using it, so setup stops before enrolling.
   */
  private foreignCredential(home: WorkerCredential, enroll: string): StepFailure {
    const shown = this.shownPath(home.path);
    const server = home.serviceUrl;
    const holds =
      server === null
        ? "holds a worker credential that names no server"
        : `holds a worker credential for ${server}`;
    const aside = `mv ${displayArgument(home.path)} ${displayArgument(`${home.path}.old`)}`;
    return new StepFailure(
      new CliError(
        "WORKER_CREDENTIAL_PRESENT",
        `${home.path} ${holds}, not ${this.answers.url}. pidgen-worker would keep using it and ignore a new enrollment, so setup enrolled nothing.`,
        ExitCode.Refused,
        { path: home.path, server, url: this.answers.url },
      ),
      enroll,
      `To enroll this machine with ${this.answers.url} instead, move it aside and run setup again: \`${aside}\`. To keep it, run setup with another PIDGEN_HOME.`,
      {
        headline: `${shown} ${holds}.`,
        lines: [
          `pidgen-worker would keep using it, so setup didn't enroll this machine with ${this.answers.url}.`,
          "To enroll it here instead, move the file aside and run setup again:",
          `  ${aside}`,
        ],
        end: `Nothing was enrolled. ${plainText(CONTINUE)}`,
      },
    );
  }

  /** The Account's name, as the person knows it, else its id. */
  private accountName(): string {
    const account = this.signedIn?.target.account ?? null;
    const membership = this.signedIn?.me.memberships.find((entry) => entry.account_id === account);
    return membership?.account_name ?? account ?? "the Account";
  }

  /** Asks whether to enroll a worker the Account revoked again (default yes); no stops setup. */
  private async confirmEnrollAgain(enroll: string): Promise<void> {
    const again = await this.prompter.confirm({
      message: `This machine's worker was removed from ${this.accountName()}. Enroll it again?`,
    });
    if (again) return;
    throw new StepFailure(
      new CliError(
        "SETUP_CANCELLED",
        `This machine's worker was removed from ${this.accountName()}, and enrolling it again was declined; nothing was enrolled or started.`,
        ExitCode.Usage,
        {},
      ),
      enroll,
      "Answer yes to enroll it again.",
    );
  }

  /**
   * The worker's name, its `display_name` on the App Service: `--label` (never asked; one the Account lists
   * unrevoked stops setup with `WORKER_NAME_TAKEN`), else the answer to the name question, asked
   * before anything is created. Its suggestion is `preferred` when no live worker holds it (and,
   * when `listedRemoved`, the Account lists it as removed): this install's newest worker's name by
   * its install id, or the removed worker's name this machine's credential names. Else, with this
   * install's worker `kept` live beside it, the next free name after it; else this host's name, or
   * the next free name when a live worker of the Account holds it.
   */
  private async chooseName(
    list: WorkerList | null,
    preferred: Preferred | null,
    kept: string | null = null,
  ): Promise<string> {
    if (this.answers.labelGiven) {
      const name = this.answers.label;
      const holder = list === null ? undefined : liveWorker(list, name);
      if (holder !== undefined) {
        const suggested = nextFreeName(list, name);
        this.note(
          `${name} is taken: ${this.accountName()} lists a live worker by that name, ${workerLabel(holder.host_id, workerName(holder))}.`,
        );
        throw this.labelNameTaken(
          name,
          suggested,
          `${this.accountName()} already has a worker named ${workerName(holder)}, so this worker was not enrolled and nothing was started.`,
          { display_name: name, suggested_name: suggested, host_id: holder.host_id },
          false,
        );
      }
      return name;
    }

    const host = this.ctx.hostName;
    const reclaim =
      preferred !== null &&
      list !== null &&
      !nameTaken(list, preferred.name) &&
      (!preferred.listedRemoved ||
        list.workers.some(
          (worker) => sameName(workerName(worker), preferred.name) && worker.revoked_at !== null,
        ));
    if (reclaim) {
      // A removed worker is offered its own name: the App Service lets its Account reclaim it.
      this.note(`Suggested worker name ${preferred.name}: ${preferred.why}.`);
      return this.askName(list, preferred.name);
    }
    if (kept !== null) {
      const suggested = nextFreeName(list, kept);
      this.note(
        `Suggested worker name ${suggested}: this install's worker ${kept} is still listed.`,
      );
      return this.askName(list, suggested);
    }
    const other = list === null ? undefined : liveWorker(list, host);
    if (other === undefined) {
      this.note(`Suggested worker name ${host}: this host's name.`);
      return this.askName(list, host);
    }
    const account = this.accountName();
    this.say(
      [
        `│\n▲  ${account} already has a worker named ${workerName(other)} (${other.connected ? "connected" : "not connected"}; enrolled ${shortDate(other.created_at)}).`,
        "   It isn't this install: it keeps its settings in another folder on this machine.",
      ].join("\n"),
    );
    const suggested = nextFreeName(list, host);
    this.note(
      `Suggested worker name ${suggested}: ${account} lists a live worker named ${workerName(other)}.`,
    );
    return this.askName(list, suggested);
  }

  /**
   * Runs `pidgen worker enroll` under `first`. Two refusals name the name as taken:
   *
   * - The App Service refuses the enrollment (HTTP 409 `WORKER_NAME_TAKEN`: the Account holds the
   *   name, by a live worker or a pending enrollment the Account's list cannot show). Nothing was
   *   created, so setup says so in one line and asks the name question again, defaulting to the
   *   server's `suggested_name`, and creates the enrollment under the answer.
   * - pidgen-worker's exchange is refused (HTTP 409 `WORKER_HOST_TAKEN`: a worker of another
   *   Account holds the host id, or this Account's removed worker on a server that does not let an
   *   Account reclaim its name). Setup says so in one line and asks the name question, defaulting to
   *   the next free name, then has the same enrollment offered again under the answer (the server
   *   leaves its token unspent on that refusal). Should the same enrollment then fail under the new
   *   name, one new enrollment is made for it, and the log names the one left unused.
   *
   * With `--label` either refusal stops setup instead, naming a name to run it again with.
   */
  private async enrollUnderFreeName(
    ctx: RunContext,
    list: WorkerList | null,
    first: string,
    revoked: boolean,
  ): Promise<{ name: string; replaced: string | null }> {
    const c = this.commands;
    // Names refused in this run, in lower case: the name question refuses them too.
    const refused = new Set<string>();
    let base: string | null = null;
    let name = first;
    let renamed = false;
    const rename = async (taken: string): Promise<string | null> => {
      refused.add(taken.toLowerCase());
      base ??= taken;
      this.note(
        `${taken} is taken in Pidgen (HTTP 409 WORKER_HOST_TAKEN): the server refused to enroll this worker under it.`,
      );
      if (this.answers.labelGiven) return null;
      this.dropTask();
      this.warn(`${taken} is taken in Pidgen, so this worker needs another name.`);
      name = await this.askName(list, nextFreeName(list, base, refused), refused);
      this.note(`Enrolling as ${name} with the same enrollment.`);
      this.begin(`Enrolling as ${name}…`, `Couldn't enroll ${name}`);
      renamed = true;
      return name;
    };
    const spec: CommandSpec = {
      ...workerEnroll,
      run: (context, input) => enrollWorker(context, input, { rename }),
    };
    const run = async () =>
      (await this.runCommand(
        c.enroll(name, revoked),
        spec,
        {
          args: ["--host-id", name],
          options: { label: name, ...(revoked ? { replaceCredential: true } : {}) },
        },
        enrollFix,
        ctx,
      )) as { replaced?: string } | null;
    const attempt = async (): Promise<{ replaced?: string } | null> => {
      try {
        return await run();
      } catch (error) {
        // The same enrollment could not be used under the new name: one new enrollment, at most.
        if (!(renamed && error instanceof StepFailure && error.error.code === "ENROLL_FAILED")) {
          throw error;
        }
        renamed = false;
        const enrollment = error.error.details["enrollment"] as { enrollment_id?: unknown } | null;
        const unused =
          typeof enrollment?.enrollment_id === "string" ? enrollment.enrollment_id : "(unknown)";
        const after =
          error.error.details["withdrawn"] === true
            ? "It was withdrawn."
            : "It could not be withdrawn and expires on its own.";
        this.note(
          `The enrollment ${unused} is left unused: pidgen-worker could not enroll ${name} with it (${error.error.message}). ${after} Creating a new enrollment for ${name}.`,
        );
        return await run();
      }
    };

    let result: { replaced?: string } | null;
    for (;;) {
      try {
        result = await attempt();
        break;
      } catch (error) {
        if (!(error instanceof StepFailure)) throw error;
        if (error.error.code === "WORKER_HOST_TAKEN") {
          throw this.labelTaken(error, list, refused, revoked);
        }
        if (error.error.code !== NAME_TAKEN) throw error;
        // No enrollment was created: ask again, with the server's suggestion filled in.
        const taken = name;
        refused.add(taken.toLowerCase());
        const given = error.error.details["suggested_name"];
        const suggested = typeof given === "string" && given.trim() !== "" ? given.trim() : null;
        const usable =
          suggested !== null &&
          suggested.length <= LABEL_MAX &&
          !refused.has(suggested.toLowerCase()) &&
          !(list !== null && nameTaken(list, suggested));
        const fallback = usable ? suggested : nextFreeName(list, taken, refused);
        this.note(
          `${taken} is taken in Pidgen (HTTP 409 WORKER_NAME_TAKEN): no enrollment was created; Pidgen suggests ${suggested ?? "no name"}.`,
        );
        if (this.answers.labelGiven) {
          if (this.active !== null) this.active.tail = [];
          throw this.labelNameTaken(
            taken,
            fallback,
            `${taken} is taken in Pidgen: the Account already has a worker or a pending enrollment by that name (HTTP 409 WORKER_NAME_TAKEN), so this worker was not enrolled and nothing was started.`,
            { ...error.error.details, suggested_name: fallback },
            revoked,
          );
        }
        this.dropTask();
        this.warn(`${taken} is taken in Pidgen, so this worker needs another name.`);
        name = await this.askName(list, fallback, refused);
        this.note(`Enrolling as ${name}.`);
        this.begin(`Enrolling as ${name}…`, `Couldn't enroll ${name}`);
      }
    }
    return {
      name,
      replaced: typeof result?.replaced === "string" ? result.replaced : null,
    };
  }

  /**
   * `WORKER_HOST_TAKEN` with `--label`: the name was answered in advance, so setup stops at the
   * enroll step, naming the next free name. Nothing is started.
   */
  private labelTaken(
    failure: StepFailure,
    list: WorkerList | null,
    refused: ReadonlySet<string>,
    revoked: boolean,
  ): StepFailure {
    const name = this.answers.label;
    const rerun = `pidgen setup --label ${displayArgument(nextFreeName(list, name, refused))}`;
    // pidgen-worker's own advice (remove the worker from the Workers page) does not apply here.
    if (this.active !== null) this.active.tail = [];
    return new StepFailure(
      new CliError(
        "WORKER_HOST_TAKEN",
        `${name} is taken in Pidgen by another worker, in this Account or another (HTTP 409 WORKER_HOST_TAKEN), so this worker was not enrolled and nothing was started.`,
        ExitCode.Refused,
        { ...failure.error.details, host_id: name },
      ),
      this.commands.enroll(name, revoked),
      `Choose another name: \`${rerun}\``,
      {
        headline: `${name} is taken in Pidgen, so setup can't enroll this worker under it.`,
        lines: ["Run setup with another name:", `  ${rerun}`],
        end: `Nothing was started. Run ${rerun} to continue from here.`,
      },
    );
  }

  /**
   * `WORKER_NAME_TAKEN` with `--label`: the name was answered in advance, so setup stops at the
   * enroll step (exit 5) with `pidgen setup --label <suggested>` as the fix. Nothing was created or
   * started.
   */
  private labelNameTaken(
    name: string,
    suggested: string,
    message: string,
    details: Record<string, unknown>,
    revoked: boolean,
  ): StepFailure {
    const rerun = `pidgen setup --label ${displayArgument(suggested)}`;
    return new StepFailure(
      new CliError(NAME_TAKEN, message, ExitCode.Refused, {
        ...details,
        display_name: name,
        suggested_name: suggested,
      }),
      this.commands.enroll(name, revoked),
      `Choose another name: \`${rerun}\``,
      {
        headline: `${name} is taken in Pidgen, so setup can't enroll this worker under it.`,
        lines: ["Run setup with another name:", `  ${rerun}`],
        end: `Nothing was started. Run ${rerun} to continue from here.`,
      },
    );
  }

  /**
   * The name question, `Worker name`, defaulting to `fallback`: an empty name, one over the label
   * limit, one the Account lists unrevoked or one the server refused in this run (`refused`, lower
   * case) keeps it open. Names are compared case-insensitively.
   */
  private async askName(
    list: WorkerList | null,
    fallback: string,
    refused: ReadonlySet<string> = new Set(),
  ): Promise<string> {
    const account = this.accountName();
    const name = await this.prompter.text({
      message: "Worker name",
      defaultValue: fallback,
      validate: (value) => {
        const answer = value.trim();
        if (answer === "") return "Enter a name for this worker.";
        if (answer.length > LABEL_MAX) return `A worker's name is at most ${LABEL_MAX} characters.`;
        if (refused.has(answer.toLowerCase())) {
          return `${answer} is taken in Pidgen: choose another name.`;
        }
        if (list !== null && nameTaken(list, answer)) {
          return `${answer} is taken: ${account} already has a worker by that name.`;
        }
        return undefined;
      },
      collapse: (value) => `Worker name · ${value.trim()}`,
    });
    return name.trim();
  }

  /** Stops setup before `pidgen worker start` when the worker home holds no credential. */
  private async requireCredential(ctx: RunContext, enroll: string): Promise<void> {
    const home = await readWorkerCredential(ctx);
    if (home.credential) return;
    const report = "pidgen feedback --kind not-working";
    throw new StepFailure(
      new CliError(
        "ENROLL_FAILED",
        `The worker has no credential for Pidgen (${home.path} holds no PIDGEN_NODE_TOKEN), so setup did not start it. That's a setup bug. Please report it: \`${report}\`.`,
        ExitCode.Unexpected,
        { path: home.path },
      ),
      enroll,
      `Report it with \`${report}\``,
    );
  }

  /** `GET /workers`, or the refusal of a credential that cannot read it. */
  private async readWorkers(): Promise<WorkersRead> {
    const session = await openSession(this.ctx, this.global);
    try {
      const response = await session.client.request<WorkerList>({
        method: "GET",
        path: WORKERS_ROUTE.path,
      });
      const list = response.data as Partial<WorkerList> | null;
      if (list === null || typeof list !== "object" || !Array.isArray(list.workers)) {
        throw new CliError(
          "UNEXPECTED_RESPONSE",
          "The server's answer to GET /workers does not match the public API document.",
          ExitCode.Unexpected,
          { route: `GET ${WORKERS_ROUTE.path}` },
        );
      }
      return { list: list as WorkerList, refused: null };
    } catch (error) {
      if (error instanceof CliError && error.exitCode === ExitCode.Auth) {
        return { list: null, refused: error };
      }
      throw error;
    }
  }

  /**
   * Reads `GET /workers` until it reports this worker connected, for up to the global `--timeout`:
   * the worker with `worker.id`, the id the worker saved in `worker.env` and authenticates as, or,
   * with none, the newest unrevoked worker named `worker.name` (compared case-insensitively).
   * `connected` is `null` when the credential cannot read the list; a timeout fails with
   * `WORKER_NOT_CONNECTED`. `id` is the worker's id as found.
   */
  private async waitConnected(
    first: WorkersRead,
    ctx: RunContext,
    worker: { id: string | null; name: string },
  ): Promise<{ connected: true | null; id: string | null }> {
    let id = worker.id;
    if (first.refused !== null) return { connected: null, id };
    const shown = () => workerLabel(id, worker.name);
    const seconds = this.global.timeoutSeconds;
    this.progress(
      "Waiting for Pidgen to report the worker connected…",
      `Pidgen didn't report ${shown()} connected`,
    );
    this.note(
      `Waiting for the App Service to report ${shown()} connected (up to ${seconds} seconds)…`,
    );
    const deadline = this.ctx.now() + seconds * 1000;
    let last: ServerView | null = null;
    let lastError: CliError | null;
    for (;;) {
      let failed: CliError | null = null;
      try {
        const read = await this.readWorkers();
        if (read.refused !== null) return { connected: null, id };
        if (id === null) {
          const named = liveWorkersNamed(read.list, worker.name).sort((a, b) =>
            b.created_at.localeCompare(a.created_at),
          );
          if (named[0] !== undefined) {
            id = named[0].host_id;
            this.note(`${worker.name} is listed as ${id}.`);
          }
        }
        last = id === null ? null : serverView(read.list, id);
        if (last?.worker?.connected === true && last.worker.revoked_at === null) {
          this.note(`${shown()} is connected.`);
          return { connected: true, id };
        }
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        failed = error;
      }
      lastError = failed;
      const remaining = deadline - this.ctx.now();
      if (remaining <= 0) break;
      await this.ctx.sleep(Math.min(CONNECT_POLL_MS, remaining));
    }

    const local = await localWorkerStatus(ctx, ctx.workerRuntime);
    const log = local.record?.log ?? null;
    throw new StepFailure(
      new CliError(
        "WORKER_NOT_CONNECTED",
        `The App Service did not report ${shown()} connected within ${seconds} seconds.`,
        ExitCode.Network,
        {
          host_id: id,
          display_name: worker.name,
          worker: last?.worker ?? null,
          running: local.running,
          log,
          last_error: lastError ? { code: lastError.code, message: lastError.message } : null,
        },
      ),
      this.commands.start(),
      `Read the worker's log${log ? ` (${log})` : ""} and run \`${this.commands.workerDoctor()}\`, and fix what they name (a longer --timeout waits longer).`,
      {
        headline: `The worker is running, but Pidgen hasn't seen it after ${seconds} seconds.`,
        lines: [
          `This is usually the network: a proxy or firewall between this machine and ${new URL(this.answers.url).host}.`,
          "Check the worker log for the connection error.",
          ...(log ? [`Worker log: ${this.shownPath(log)}`] : []),
        ],
        end: `${plainText(CONTINUE)} With --timeout ${Math.max(300, seconds * 2)} it waits longer.`,
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // 6. Prove it

  private async prove(): Promise<StepResult> {
    this.begin("Running the worker's checks…", "The worker's checks failed");
    const report = await this.runCommand(
      this.commands.workerDoctor(),
      workerDoctor,
      {},
      () => "Fix what error.details (the worker's report) names.",
    );
    this.done("Worker checks passed");
    // `next` is filled in when setup ends, with the one next thing to do.
    return { status: "done", summary: "The worker's own checks passed.", report, next: null };
  }

  /** The one next thing to do: install the agent skills, or, with them installed, file a ticket. */
  private async nextCommand(): Promise<{ command: string; why: string }> {
    let current = false;
    try {
      const rows = await skillsStatus(this.ctx, { agent: "all", scope: "user" });
      current = rows.length > 0 && rows.every((row) => row.state === "current");
    } catch {
      // Skills that cannot be read are treated as not installed.
    }
    return current
      ? {
          command: this.commands.pidgen(["ticket", "template"]),
          why: "write a first ticket from the template, then file it with pidgen ticket create -f <file>",
        }
      : {
          command: this.commands.pidgen(["skills", "install"], { account: false }),
          why: "install the agent skills so your coding agent can file and follow work",
        };
  }
}

/**
 * The prompter, with each question and its answer also written to the setup log. A question
 * never opens while a task's spinner runs: setup ends a task before it asks. Once Ctrl-C or
 * SIGTERM has stopped setup (`stopped`), no question opens: it rejects with that cancellation.
 */
function loggedPrompter(
  prompter: Prompter,
  log: SetupLog,
  stopped: () => PromptCancelled | null,
): Prompter {
  const asked = async <T>(
    message: string,
    answer: () => Promise<T>,
    detail?: string,
  ): Promise<T> => {
    const cancelled = stopped();
    if (cancelled !== null) throw cancelled;
    log.event(`question: ${message}`);
    for (const line of detail ? detail.split("\n") : []) log.line(`  ${line}`);
    try {
      const value = await answer();
      log.event(`answer: ${JSON.stringify(value)}`);
      return value;
    } catch (error) {
      if (error instanceof PromptCancelled) log.event("answer: cancelled (Ctrl-C)");
      throw error;
    }
  };
  return {
    intro: (title) => {
      log.event(title);
      prompter.intro(title);
    },
    outro: (message) => {
      log.event(message);
      prompter.outro(message);
    },
    cancel: (message, next) => {
      log.event(`${message} ${next}`);
      prompter.cancel(message, next);
    },
    select: (question) => asked(question.message, () => prompter.select(question)),
    multiselect: (question) => asked(question.message, () => prompter.multiselect(question)),
    text: (question) => asked(question.message, () => prompter.text(question)),
    confirm: (question) =>
      asked(question.message, () => prompter.confirm(question), question.detail),
    spinner: () => prompter.spinner(),
    taskLog: (title) => prompter.taskLog(title),
    wait: (question) => prompter.wait(question),
    onInterrupt: (listener) => prompter.onInterrupt(listener),
    close: () => prompter.close(),
  };
}

/** A child process's exit status; one that could not start is `ExitCode.Unexpected`. */
function exitStatus(child: ChildProcess): Promise<number> {
  return new Promise((resolveStatus) => {
    let settled = false;
    const settle = (status: number) => {
      if (settled) return;
      settled = true;
      resolveStatus(status);
    };
    child.once("error", () => settle(ExitCode.Unexpected));
    child.once("close", (code: number | null) => settle(code ?? ExitCode.Unexpected));
  });
}

/** The fix for a failed `pidgen worker install`. */
function installFix(error: CliError): string {
  switch (error.code) {
    case "SETUP_CANCELLED":
      return "Run `pidgen setup` again and accept the licence to install the worker (or give `--accept-licence`).";
    case "RUNTIME_UNAVAILABLE":
      return `Install uv: \`${UV_INSTALL_COMMAND}\`.`;
    case "RELEASE_UNSUPPORTED": {
      const accepted = error.details["accepted"];
      const list = Array.isArray(accepted) ? accepted.join(", ") : "a series the server accepts";
      return `Run \`pidgen setup --version <version>\` with a release of one of: ${list}.`;
    }
    case "PROVENANCE_INVALID":
      return "Nothing was installed: the release did not verify against the worker's release identity. Do not install it by other means; report it with `pidgen feedback --kind not-working`, and run `pidgen setup` again later.";
    case "NOT_FOUND":
      return "The server does not publish its worker release list yet; ask its operator, and run `pidgen setup` again later.";
    case "INSTALL_FAILED":
      return "Read uv's output (its last lines above, all of it in the setup log) and fix what it names.";
    default:
      return "Fix the error.";
  }
}

/** The fix for a failed `pidgen worker enroll`. */
function enrollFix(error: CliError): string {
  if (error.exitCode === ExitCode.Auth) {
    return `This credential may not enroll workers here: an Account Owner or Administrator can, or a Personal API Token with ${ENROLL_SCOPE}.`;
  }
  if (error.code === "ENTITLEMENT_LIMIT_REACHED") {
    return "The Account has enrolled all the workers it may; revoke one in the web app.";
  }
  if (error.details["withdrawn"] === true) {
    return "Fix the error. The enrollment setup created was withdrawn, so nothing is left waiting.";
  }
  return "Fix the error. The unused enrollment expires on its own.";
}
