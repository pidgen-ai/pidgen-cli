import { Option, type Command } from "commander";
import { DEFAULT_SERVER_URL, loadConfig, resolveTarget, type Target } from "../../core/config.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import type { DoctorCheck } from "../../core/doctor.js";
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
import { findOnPath, findWorker, workerStatus as localWorkerStatus } from "../../core/worker.js";
import {
  displayArgument,
  licenceNotice,
  readInstallRecord,
  RUNTIME_INSTRUCTIONS,
  runtimeUnavailable,
  type InstallRecord,
  type WorkerForm,
} from "../../core/worker-install.js";
import { readWorkerReleases } from "../../core/worker-releases.js";
import type { components } from "../../generated/api.js";
import { accountUse } from "../account/use.js";
import { authLogin, parseServerUrl } from "../auth/login.js";
import { doctorChecks } from "../doctor/doctor.js";
import { workerDoctor } from "../worker/doctor.js";
import { workerEnroll } from "../worker/enroll.js";
import { workerInstall } from "../worker/install.js";
import { workerStart } from "../worker/start.js";
import { serverView, WORKERS_ROUTE, type ServerView } from "../worker/status.js";
import { workerVerify } from "../worker/verify.js";

type WorkerList = components["schemas"]["WorkerList"];

/** The hosted Pidgen service, signed in to when no server is configured and `--url` is not given. */
export const HOSTED_SERVICE_URL = DEFAULT_SERVER_URL;

/** How often setup reads `GET /workers` while waiting for the worker to connect. */
const CONNECT_POLL_MS = 2_000;
/** The longest enrollment label the public API document accepts. */
const LABEL_MAX = 100;
/** How many answers a question takes before setup gives up on it. */
const ATTEMPTS = 3;

/** Doctor checks a later step fixes, so they do not stop setup: sign-in, and the install. */
const FIXED_LATER = new Map([
  ["credential", "signing in"],
  ["worker", "installing"],
]);

export type SetupStepId = "check" | "sign-in" | "runtime" | "install" | "enroll" | "prove";
export type SetupStepStatus = "done" | "skipped" | "failed";

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
  label: string;
  url: string;
}

/**
 * `pidgen setup [--runtime wheel] [--version <version>] [--test] [--label <label>] [--url <url>]`: the guided
 * path from a fresh machine to a verified worker connected to the App Service, and the CLI's one
 * interactive command. It runs six steps in order, printing each as the `pidgen` command it runs:
 *
 * 1. `check`: `pidgen doctor`; a failing check a later step cannot fix stops setup.
 * 2. `sign-in`: `pidgen auth login <url>` (device code), the Account question only when the User
 *    belongs to more than one, then whether the credential may enroll workers.
 * 3. `runtime`: the one question, defaulting to what the machine has, with the licence notice.
 * 4. `install`: `pidgen worker install`, then `pidgen worker verify`.
 * 5. `enroll`: `pidgen worker enroll --label <label>` and `pidgen worker start --detach`, then waits
 *    until `GET /workers` reports this worker connected.
 * 6. `prove`: `pidgen worker doctor`, then the one next thing to do.
 *
 * A signed-in profile, an installed worker and an enrolled host are detected and skipped, so running
 * it again resumes. A failed step stops it with the command, its error and the fix. Without a
 * terminal it exits 2 with `TERMINAL_REQUIRED` and the equivalent commands.
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
      );
  },
  async run(ctx, { options, global }) {
    const answers = await readAnswers(ctx, options, global);
    const commands = new Commands(global, answers);
    if (ctx.ask === null) {
      throw new CliError(
        "TERMINAL_REQUIRED",
        "pidgen setup asks questions and needs a terminal on standard input and standard error. Run the commands in error.details.commands instead, in order.",
        ExitCode.Usage,
        { commands: commands.equivalent() },
      );
    }
    return new SetupRun(ctx, ctx.ask, global, answers, commands).run();
  },
};

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
    url,
  };
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

function sameServer(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
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
  enroll = () => this.pidgen(["worker", "enroll", "--label", this.answers.label]);
  start = () => this.pidgen(["worker", "start", "--detach"]);
  status = () => this.pidgen(["worker", "status"]);
  workerDoctor = () => this.pidgen(["worker", "doctor"]);

  /** What setup runs, in order, for a person without a terminal to run themselves. */
  equivalent(): string[] {
    return [
      this.doctor(),
      this.login(),
      this.install(this.answers.runtime),
      this.verify(),
      this.enroll(),
      this.start(),
      this.status(),
      this.workerDoctor(),
    ];
  }
}

/** A step that stopped: the command that failed, its error, and the fix. */
class StepFailure extends Error {
  constructor(
    readonly error: CliError,
    readonly command: string | null,
    readonly fix: string,
  ) {
    super(error.message);
  }
}

interface SignedIn {
  target: Target;
  me: Me;
  permission: EnrollPermission;
}

/** The App Service's view of this host, or the refusal that kept it from being read. */
type WorkersRead = { view: ServerView; refused: null } | { view: null; refused: CliError };

const AGAIN = "then run `pidgen setup` again";

class SetupRun {
  private readonly steps: SetupStep[] = [];
  private workerCheck: DoctorCheck | undefined;
  private signedIn: SignedIn | null = null;
  private form: WorkerForm | undefined;
  private skipInstall = false;

  constructor(
    private readonly ctx: RunContext,
    private readonly ask: (question: string) => Promise<string>,
    private readonly global: GlobalOptions,
    private readonly answers: Answers,
    private readonly commands: Commands,
  ) {}

  async run(): Promise<CommandResult> {
    const c = this.commands;
    await this.step("check", c.doctor(), () => this.check());
    await this.step("sign-in", c.login(), () => this.signIn());
    await this.step("runtime", null, () => this.chooseRuntime());
    const install = `${c.install(this.form)} && ${c.verify()}`;
    await this.step("install", install, () => this.install());
    await this.step("enroll", `${c.enroll()} && ${c.start()}`, () => this.enrollAndStart());
    await this.step("prove", c.workerDoctor(), () => this.prove());
    this.say("\nThis machine runs a verified worker connected to Pidgen.");
    return {
      data: { steps: this.steps },
      meta: this.signedIn ? responseMeta(this.signedIn.target) : {},
    };
  }

  // -------------------------------------------------------------------------------------------
  // Running steps

  private async step(
    id: SetupStepId,
    command: string | null,
    body: () => Promise<StepResult>,
  ): Promise<void> {
    try {
      const { status, summary, ...details } = await body();
      this.steps.push({ id, status, command, summary, ...details });
    } catch (error) {
      const failure =
        error instanceof StepFailure
          ? error
          : error instanceof CliError
            ? new StepFailure(error, command, `Fix the error, ${AGAIN}.`)
            : null;
      if (failure === null) throw error;
      this.steps.push({ id, command, status: "failed", summary: failure.error.message });
      const ran = failure.command ?? command;
      throw new CliError(
        failure.error.code,
        `Setup stopped at ${id}${ran ? `: \`${ran}\` failed` : ""}: ${failure.error.message} Fix: ${failure.fix}`,
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
          fix: failure.fix,
          steps: this.steps,
        },
      );
    }
  }

  /** Runs one scriptable command after printing it; its failure becomes the step's. */
  private async runCommand(
    command: string,
    spec: CommandSpec,
    input: Partial<CommandInput>,
    fix: (error: CliError) => string,
    ctx: RunContext = this.ctx,
    display: string = command,
  ): Promise<unknown> {
    this.say(`$ ${display}`);
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

  private say(text: string): void {
    this.ctx.io.stderr(`${text}\n`);
  }

  /** Asks until the answer is one of `choices` (an empty answer is `fallback`). */
  private async choose<T>(
    question: string,
    choices: ReadonlyMap<string, T>,
    fallback: T,
    hint: string,
  ): Promise<T> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const answer = (await this.ask(question)).trim();
      if (answer === "") return fallback;
      const chosen = choices.get(answer.toLowerCase());
      if (chosen !== undefined) return chosen;
      this.say(`"${answer}" is not one of the answers: ${hint}.`);
    }
    throw usageError(`No answer setup knows after ${ATTEMPTS} tries: ${hint}.`);
  }

  // -------------------------------------------------------------------------------------------
  // 1. Check

  private async check(): Promise<StepResult> {
    this.say(`$ ${this.commands.doctor()}`);
    // Before sign-in no server may be configured yet: check the one setup signs in to.
    const configured = await configuredUrl(this.ctx, this.global);
    const ctx =
      configured !== null && sameServer(configured, this.answers.url)
        ? this.ctx
        : { ...this.ctx, env: { ...this.ctx.env, PIDGEN_API_URL: this.answers.url } };
    const { checks } = await doctorChecks(ctx, this.global);
    for (const entry of checks) {
      const later = entry.status === "fail" ? FIXED_LATER.get(entry.id) : undefined;
      this.say(
        `  ${entry.status.padEnd(4)}  ${entry.id}  ${entry.summary}${later ? ` (${later} fixes this)` : ""}`,
      );
    }
    this.workerCheck = checks.find((entry) => entry.id === "worker");

    const blocking = checks.filter(
      (entry) => entry.status === "fail" && !FIXED_LATER.has(entry.id),
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
        `${blocking.map((entry) => `${entry.id}: ${entry.fix ?? "see its summary"}`).join("; ")}; ${AGAIN}`,
      );
    }
    const warnings = checks.filter((entry) => entry.status === "warn").length;
    return {
      status: "done",
      summary: `Nothing on this machine stops setup${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`,
    };
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
        signedIn = await this.chooseAccount(signedIn);
      }
    } else {
      this.say(
        `Signed in to ${this.answers.url} for ${signedIn.target.account}; skipping sign-in.`,
      );
    }
    this.signedIn = signedIn;

    const enroll = this.describePermission(signedIn);
    return {
      status,
      summary: `Signed in as ${signedIn.me.user.email} for ${signedIn.target.account}.`,
      account: signedIn.target.account,
      enroll,
    };
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
          `PIDGEN_TOKEN is set and the server refuses it: set it to a valid token, or unset it to sign in with a device code; ${AGAIN}`,
        );
      }
      return null;
    }
  }

  /** Device-code login; the Account is chosen when the login is approved. Returns that Account. */
  private async login(): Promise<string> {
    // A device-code login chooses its Account when it is approved, so --account is not passed.
    const global: GlobalOptions = {
      format: this.global.format,
      timeoutSeconds: this.global.timeoutSeconds,
      ...(this.global.profile !== undefined ? { profile: this.global.profile } : {}),
    };
    const data = (await this.runCommand(
      this.commands.login(),
      authLogin,
      { args: [this.answers.url], global },
      () => `Approve the login in the web app before the code expires; ${AGAIN}.`,
    )) as { account: string };
    return data.account;
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
      `Approve the login for ${wanted}, or run setup without --account; ${AGAIN}`,
    );
  }

  /** The Account question, asked only when the User belongs to more than one Account. */
  private async chooseAccount(signedIn: SignedIn): Promise<SignedIn> {
    const current = signedIn.target.account;
    const memberships = signedIn.me.memberships;
    const choices = new Map<string, string>();
    const lines = memberships.map((entry, index) => {
      choices.set(String(index + 1), entry.account_id);
      choices.set(entry.account_id.toLowerCase(), entry.account_id);
      const mark = entry.account_id === current ? "  (signed in)" : "";
      return `  ${index + 1}. ${entry.account_id}  ${entry.account_name}, ${entry.role}${mark}`;
    });
    const fallbackIndex = Math.max(
      1,
      memberships.findIndex((entry) => entry.account_id === current) + 1,
    );
    const chosen = await this.choose(
      `You belong to ${memberships.length} Accounts:\n${lines.join("\n")}\nWhich Account will this worker serve? [${fallbackIndex}] `,
      choices,
      current ?? memberships[0]!.account_id,
      `a number from 1 to ${memberships.length}, or an Account id`,
    );
    if (chosen === current) return signedIn;

    const config = await loadConfig(this.ctx);
    const profile = config.profiles[signedIn.target.profile];
    if (profile?.credentials[chosen] === undefined) {
      this.say(`Sign in again and approve the login for ${chosen}.`);
      const approved = await this.login();
      if (approved !== chosen) {
        throw new StepFailure(
          new CliError(
            "ACCOUNT_MISMATCH",
            `The login was approved for ${approved}, not ${chosen}.`,
            ExitCode.Auth,
            { approved, account: chosen },
          ),
          this.commands.login(),
          `Approve the login for ${chosen}; ${AGAIN}`,
        );
      }
    }
    await this.runCommand(
      this.commands.accountUse(chosen),
      accountUse,
      { args: [chosen] },
      () => `Sign in for ${chosen} with \`${this.commands.login()}\`; ${AGAIN}`,
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
        `Sign in for ${chosen} with \`${this.commands.login()}\`; ${AGAIN}`,
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
      this.say(
        `This credential may enroll workers in ${account} (${permission.role ? `role ${permission.role}; ` : ""}it holds ${ENROLL_SCOPE}).`,
      );
    } else {
      const reason =
        permission.kind === "pat"
          ? `the Personal API Token lacks ${ENROLL_SCOPE}`
          : `your role is ${permission.role ?? "unknown"}`;
      this.say(
        [
          `This credential may not enroll workers in ${account}: ${reason}.`,
          `An Account ${roles} can enroll workers. Or create a Personal API Token with ${ENROLL_SCOPE} in the web app and sign in with it:`,
          `  ${tokenCommand}`,
          "Setup still installs the worker; it stops before enrolling.",
        ].join("\n"),
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

  // -------------------------------------------------------------------------------------------
  // 3. Choose a runtime

  private async chooseRuntime(): Promise<StepResult> {
    const record = await readInstallRecord(this.ctx);
    const { runtime, version } = this.answers;
    this.skipInstall =
      record !== null &&
      (runtime === undefined || record.form === runtime) &&
      (version !== undefined ? record.version === version : this.workerCheck?.status !== "fail");
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
      throw new StepFailure(runtimeUnavailable(), null, RUNTIME_INSTRUCTIONS.wheel.instructions);
    }
    const { list } = await readWorkerReleases(this.ctx, this.global);
    const fallback = record?.form ?? available[0]!;
    this.say(licenceNotice(list.eula).trimEnd());
    const choices = new Map(available.map((form) => [form, form] as const));
    this.form = await this.choose(
      `Worker runtime (${available.join(", ")}; the container runtime is planned) [${fallback}] `,
      choices,
      fallback,
      available.join(" or "),
    );
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
    if (this.skipInstall) {
      const record = await readInstallRecord(this.ctx);
      this.say("The worker is installed; skipping the install.");
      return { status: "skipped", summary: `pidgen-worker ${record?.version} is installed.` };
    }
    const installed = (await this.runCommand(
      this.commands.install(this.form),
      workerInstall,
      { options: { runtime: this.form, version: this.answers.version, force: false } },
      installFix,
    )) as InstallRecord;
    const verified = (await this.runCommand(
      this.commands.verify(),
      workerVerify,
      {},
      () => `Reinstall it with \`pidgen worker install --force\`; ${AGAIN}`,
    )) as { checks: DoctorCheck[] };
    for (const entry of verified.checks) {
      this.say(`  ${entry.status.padEnd(4)}  ${entry.id}  ${entry.summary}`);
    }
    return {
      status: "done",
      summary: `pidgen-worker ${installed.version} is installed and verified (${installed.digest}).`,
      version: installed.version,
    };
  }

  // -------------------------------------------------------------------------------------------
  // 5. Enroll and start

  private async enrollAndStart(): Promise<StepResult> {
    const c = this.commands;
    const { ctx, prefix } = await this.workerContext();
    const host = this.ctx.hostName;

    const read = await this.readWorkers();
    const local = await localWorkerStatus(ctx, ctx.workerRuntime);
    // A credential that cannot read the list (a Personal API Token) leaves only the local view: a
    // worker that is running was enrolled.
    const enrolled = read.view !== null ? read.view.enrolled : local.running;
    let ran = false;

    if (enrolled) {
      this.say(`${host} is enrolled; skipping the enrollment.`);
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
          c.enroll(),
          `Ask an Account Owner or Administrator to run setup, or sign in with a Personal API Token that has ${ENROLL_SCOPE}: \`${c.tokenLogin(account)}\`; ${AGAIN}`,
        );
      }
      await this.runCommand(
        c.enroll(),
        workerEnroll,
        { options: { label: this.answers.label } },
        enrollFix,
        ctx,
        `${prefix}${c.enroll()}`,
      );
      ran = true;
    }

    if (local.running && local.record !== null) {
      this.say(`pidgen-worker is already running (pid ${local.record.pid}); skipping the start.`);
    } else {
      await this.runCommand(
        c.start(),
        workerStart,
        { options: { detach: true } },
        (error) =>
          error.code === "WORKER_EXITED"
            ? `Read error.details.log_tail and the worker's log, fix what it names; ${AGAIN}`
            : `Fix the error; ${AGAIN}`,
        ctx,
        `${prefix}${c.start()}`,
      );
      ran = true;
    }

    const connected = await this.waitConnected(read, ctx);
    return {
      status: ran ? "done" : "skipped",
      summary:
        connected === true
          ? `${host} is enrolled, running, and connected to the App Service.`
          : `${host} is enrolled and running. This credential cannot read GET /workers (${read.refused?.code ?? "refused"}), so setup cannot confirm it connected: run \`${c.status()}\` signed in as an Account Owner or Administrator.`,
      host_id: host,
      connected,
    };
  }

  /**
   * The context worker commands run in: when `pidgen-worker` is not on `PATH` (uv's tool directory
   * often is not), `PIDGEN_WORKER_BIN` names the installed one, and the printed commands say so.
   */
  private async workerContext(): Promise<{ ctx: RunContext; prefix: string }> {
    if ((await findWorker(this.ctx, this.ctx.workerRuntime)) !== null) {
      return { ctx: this.ctx, prefix: "" };
    }
    const record = await readInstallRecord(this.ctx);
    if (record === null) return { ctx: this.ctx, prefix: "" };
    this.say(
      `pidgen-worker is not on PATH; using ${record.location}. Add its directory to PATH (\`uv tool update-shell\`) to run it by name.`,
    );
    return {
      ctx: { ...this.ctx, env: { ...this.ctx.env, PIDGEN_WORKER_BIN: record.location } },
      prefix: `PIDGEN_WORKER_BIN=${displayArgument(record.location)} `,
    };
  }

  /** `GET /workers`, this host's entry in it, or the refusal of a credential that cannot read it. */
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
      return { view: serverView(list as WorkerList, this.ctx.hostName), refused: null };
    } catch (error) {
      if (error instanceof CliError && error.exitCode === ExitCode.Auth) {
        return { view: null, refused: error };
      }
      throw error;
    }
  }

  /**
   * Reads `GET /workers` until it reports this host connected, for up to the global `--timeout`.
   * `null` when the credential cannot read the list; a timeout fails with `WORKER_NOT_CONNECTED`.
   */
  private async waitConnected(first: WorkersRead, ctx: RunContext): Promise<true | null> {
    if (first.refused !== null) return null;
    const host = this.ctx.hostName;
    const seconds = this.global.timeoutSeconds;
    this.say(`Waiting for the App Service to report ${host} connected (up to ${seconds} seconds)…`);
    const deadline = this.ctx.now() + seconds * 1000;
    let last: ServerView | null = null;
    let lastError: CliError | null;
    for (;;) {
      let failed: CliError | null = null;
      try {
        const read = await this.readWorkers();
        if (read.refused !== null) return null;
        last = read.view;
        if (last.worker?.connected === true && last.worker.revoked_at === null) {
          this.say(`${host} is connected.`);
          return true;
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
        `The App Service did not report ${host} connected within ${seconds} seconds.`,
        ExitCode.Network,
        {
          host_id: host,
          worker: last?.worker ?? null,
          running: local.running,
          log,
          last_error: lastError ? { code: lastError.code, message: lastError.message } : null,
        },
      ),
      this.commands.start(),
      `Read the worker's log${log ? ` (${log})` : ""} and run \`${this.commands.workerDoctor()}\`; fix what they name, ${AGAIN} (a longer --timeout waits longer).`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // 6. Prove it

  private async prove(): Promise<StepResult> {
    const { ctx, prefix } = await this.workerContext();
    const report = await this.runCommand(
      this.commands.workerDoctor(),
      workerDoctor,
      {},
      () => `Fix what error.details (the worker's report) names, ${AGAIN}.`,
      ctx,
      `${prefix}${this.commands.workerDoctor()}`,
    );
    this.say("The worker's own checks passed.");
    const next = await this.nextCommand();
    this.say(`\nNext: ${next.why}\n  ${next.command}`);
    return {
      status: "done",
      summary: "The worker's own checks passed.",
      report,
      next: next.command,
    };
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
          why: "file a first ticket: write it from the template, then `pidgen ticket create -f <file>`.",
        }
      : {
          command: this.commands.pidgen(["skills", "install"], { account: false }),
          why: "install the Pidgen agent skills, so your coding agent can file and follow work.",
        };
  }
}

/** The fix for a failed `pidgen worker install`. */
function installFix(error: CliError): string {
  switch (error.code) {
    case "RUNTIME_UNAVAILABLE":
      return `${RUNTIME_INSTRUCTIONS.wheel.instructions.replace("pidgen worker install", "pidgen setup")}`;
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
      return `Read uv's output above and fix what it names; ${AGAIN}.`;
    default:
      return `Fix the error; ${AGAIN}.`;
  }
}

/** The fix for a failed `pidgen worker enroll`. */
function enrollFix(error: CliError): string {
  if (error.exitCode === ExitCode.Auth) {
    return `This credential may not enroll workers here: an Account Owner or Administrator can, or a Personal API Token with ${ENROLL_SCOPE}; ${AGAIN}.`;
  }
  if (error.code === "ENTITLEMENT_LIMIT_REACHED") {
    return `The Account has enrolled all the workers it may; revoke one in the web app, ${AGAIN}.`;
  }
  return `Fix the error; ${AGAIN}. The unused enrollment expires on its own.`;
}
