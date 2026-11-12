import type { Command } from "commander";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { validateBody } from "../../core/input.js";
import { ensureInstallId, invalidInstallIdNote } from "../../core/install-id.js";
import type { CommandInput, CommandResult, CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import {
  findWorker,
  moveWorkerCredentialAside,
  type WorkerEnrollResult,
  readWorkerCredential,
  restoreWorkerCredential,
  runWorkerEnroll,
} from "../../core/worker.js";
import { displayArgument, installWorker, type InstallRecord } from "../../core/worker-install.js";
import type { ResolvedRelease } from "../../core/worker-index.js";
import {
  createEnrollment,
  ENROLL_ROUTE,
  WORKER_ENROLLMENTS_DOCUMENT,
  withdrawEnrollment,
  type CreatedEnrollment,
  type Withdrawal,
} from "../../core/worker-enrollments.js";
import type { WorkerReleaseList } from "../../core/worker-releases.js";
import type { components } from "../../generated/worker-enrollments.js";

type InstallOption = components["schemas"]["InstallOption"];

/** The operation `worker enroll` sends, as the pending fragment names it. */
export { ENROLL_ROUTE };

/** The command that installs the worker on its own; `worker enroll` runs the same install. */
const INSTALL_COMMAND = "pidgen worker install";

/** The command that starts the worker with the credential its worker home holds. */
const START_COMMAND = "pidgen worker start";

const REDACTED = "[redacted]";

const CREDENTIAL_HELP = `
A worker home whose worker.env already holds a credential is refused, exit 5 with
WORKER_CREDENTIAL_PRESENT, before anything is installed or an enrollment is created: pidgen-worker
would use the saved credential and never redeem the new enrollment. Run \`${START_COMMAND}\` to use
it, or pass --replace-credential to move worker.env aside to worker.env.replaced-<UTC timestamp>
(same folder, mode 0600, never read or printed) and enroll anew; data.replaced names the moved file.`;

/**
 * An install option the server returned, as the CLI reports it: what the server suggests, never the
 * token-bearing steps. The CLI only reports it; it never runs it.
 */
export interface ReportedInstallOption {
  form: string;
  artifact: string;
  install: string;
}

/**
 * `pidgen worker enroll [--label <label>] [--install | --no-install] [-- args]`: installs the worker
 * when it is missing and `--install` agrees, then creates an enrollment in the current Account
 * (`POST /workers/enrollments`) and runs `pidgen-worker enroll --token <one-time token> --server
 * <server> --no-start [args]`.
 *
 * The install is the one `pidgen worker install` runs, with the same verification and the same
 * printed commands, and it happens before the enrollment is created, so a failed or refused
 * install spends no enrollment. The CLI never runs a command string from the server.
 *
 * It never asks: `pidgen setup` is the CLI's one interactive command, and it installs and verifies
 * the worker before enrolling. `--install` agrees in advance; `--no-install` never installs, and
 * with no worker installed exits 2 (`WORKER_NOT_FOUND`). With neither flag and no worker installed
 * it exits 2 (`INSTALL_CONFIRMATION_REQUIRED`), on a terminal or not. The one-time token goes only
 * to `pidgen-worker`: it is never printed, never in the envelope, and never written to the CLI's
 * configuration.
 *
 * `pidgen-worker enroll` keeps a credential its worker home's `worker.env` already holds and skips
 * the exchange, so a home holding one is refused (exit 5, `WORKER_CREDENTIAL_PRESENT`) before
 * anything is installed or created, unless `--replace-credential` moves `worker.env` aside to
 * `worker.env.replaced-<UTC timestamp>` just before the enrollment is created. The CLI renames the
 * file without reading the credential's value, and reports the new path in `data.replaced`.
 */
export const workerEnroll: CommandSpec = {
  path: ["worker", "enroll"],
  summary: "Install the worker with --install, create an enrollment, and run pidgen-worker enroll",
  configure(command: Command) {
    command
      .option("--label <label>", "a name for the enrollment, shown in lists")
      .option("--install", "install the worker without asking when it is missing")
      .option("--no-install", "never install the worker; fail when it is missing")
      .option(
        "--replace-credential",
        "move a worker.env that holds a credential aside before enrolling, instead of refusing",
      )
      .argument("[args...]")
      .addHelpText("after", CREDENTIAL_HELP);
  },
  run: (ctx, input) => enrollWorker(ctx, input),
};

/**
 * What a caller running `worker enroll` in the same process (`pidgen setup`) may do when the server
 * refuses the worker's host id as taken: `rename(taken)` returns another host id to run
 * `pidgen-worker enroll` again with, under the same enrollment (the server leaves its token unspent
 * on that refusal, and the token never leaves this command), or `null` to stop with
 * `WORKER_HOST_TAKEN`. The command line has no such hook: `worker enroll` never asks.
 */
export interface EnrollHooks {
  rename?: (taken: string) => Promise<string | null>;
  /**
   * The server refused `pidgen-worker enroll`'s request as sent (HTTP 422, read from the worker's
   * reason line whatever its words). The host id is the only part of that request a person chose,
   * and the server leaves the enrollment's token unspent on that refusal: `requestRefused(hostId)`
   * (the host id refused, or `null` when the arguments named none) returns another host id to run
   * `pidgen-worker enroll` again with, under the same enrollment, or `null` to stop with
   * `ENROLL_FAILED`.
   */
  requestRefused?: (hostId: string | null) => Promise<string | null>;
}

/** Whether a failed `pidgen-worker enroll` run was the server's refusal of its request (HTTP 422). */
export function refusedAsSent(run: WorkerEnrollResult): boolean {
  return run.status !== ExitCode.Ok && !run.hostTaken && run.refusal?.http_status === 422;
}

/** `pidgen worker enroll`, with the hooks an in-process caller may give. */
export async function enrollWorker(
  ctx: RunContext,
  { args: given, options, global }: CommandInput,
  hooks: EnrollHooks = {},
): Promise<CommandResult> {
  const install = typeof options["install"] === "boolean" ? options["install"] : undefined;
  const typedLabel = typeof options["label"] === "string" ? options["label"] : undefined;
  // A name is the worker's name only once its spaces are replaced: the label and the host id alike.
  const label = typedLabel === undefined ? undefined : normalizeWorkerName(typedLabel);
  const replace = options["replaceCredential"] === true;
  const body = label === undefined ? {} : { label };
  // A label the contract refuses is refused before anything is installed or created.
  validateBody(WORKER_ENROLLMENTS_DOCUMENT, ENROLL_ROUTE.method, ENROLL_ROUTE.path, body);
  // So is a name the server would refuse as a host id: it is never sent.
  if (label !== undefined) requireWorkerName("--label", label);
  let args = withNormalizedHostId(given);
  const hostId = hostIdOf(args);
  if (hostId !== null) requireWorkerName("--host-id", hostId);

  // pidgen-worker skips the exchange when worker.env holds a credential, so an enrollment created
  // now would never be used: refuse before anything is installed or an enrollment is created.
  if (!replace) {
    const saved = await readWorkerCredential(ctx);
    if (saved.credential) throw credentialPresent(saved.path);
  }

  // Refuses an unsupported platform before anything is installed or an enrollment is spent.
  let worker = await findWorker(ctx, ctx.workerRuntime);
  let installed: InstallRecord | null = null;
  if (worker === null) {
    installed = await installMissingWorker(ctx, global, install);
    worker = await findWorker(ctx, ctx.workerRuntime);
    if (worker === null) {
      throw new CliError(
        "WORKER_NOT_FOUND",
        `The worker was installed at ${installed.location}, but it cannot be run from there. Run \`pidgen worker install --force\`, then enroll again.`,
        ExitCode.Usage,
        { installed },
      );
    }
  }

  // Only now, with a verified worker present, is the enrollment created; a replaced credential
  // is moved aside first, so pidgen-worker exchanges the new enrollment instead of skipping it.
  const session = await openSession(ctx, global);
  // This install's id, made now when absent; it survives worker.env being moved aside.
  const thisInstall = await ensureInstallId(ctx);
  if (thisInstall.invalid) ctx.io.stderr(`${invalidInstallIdNote(thisInstall.path)}\n`);
  const replaced = replace ? await moveWorkerCredentialAside(ctx, ctx.now()) : null;
  if (replaced !== null) progress(ctx, `Moved the saved worker credential to ${replaced}\n`);
  let response;
  let installId: string | null;
  try {
    ({ response, installId } = await createEnrollment(
      session.client,
      body,
      thisInstall.id,
      (text) => progress(ctx, text),
    ));
  } catch (error) {
    // No enrollment was created: the saved credential goes back where the worker reads it.
    if (replaced !== null) await restoreWorkerCredential(ctx, replaced);
    if (error instanceof CliError && error.code === NAME_TAKEN) throw nameTaken(error, label);
    throw error;
  }
  const created = response.data;
  const token = created.token;
  const report = {
    enrollment: enrollmentSummary(created),
    install: created.install.map(reportedOption),
    eula: created.eula,
    install_id: installId,
    ...(replaced !== null ? { replaced } : {}),
  };

  try {
    progress(ctx, `Enrolling with ${worker}\n`);
    const server = session.target.url;
    for (;;) {
      const run = await runWorkerEnroll(ctx, worker, token, server, args, ctx.workerRuntime);
      if (run.status === ExitCode.Ok) break;
      if (refusedAsSent(run) && hooks.requestRefused) {
        const next = await hooks.requestRefused(hostIdOf(args));
        if (next === null) throw enrollFailed(run, { ...report, exit_code: run.status, worker });
        // The same enrollment, under another host id: the refused token was not spent.
        args = withHostId(args, next);
        continue;
      }
      if (!run.hostTaken) throw enrollFailed(run, { ...report, exit_code: run.status, worker });
      const taken = run.refusedHostId ?? hostIdOf(args);
      const next = taken !== null && hooks.rename ? await hooks.rename(taken) : null;
      if (next === null) throw hostTaken(taken, { ...report, exit_code: run.status, worker });
      // The same enrollment, under another host id: the refused token was not spent.
      args = withHostId(args, next);
    }
    return {
      data: redact({ ...report, installed, worker, enrolled: true }, token),
      meta: session.meta(response),
    };
  } catch (error) {
    // The enrollment cannot be used: withdraw it, so it does not wait for 24 hours holding a
    // worker slot, then report the failure as it was.
    const withdrawal = await withdrawEnrollment(session.client, created.enrollment_id);
    noteWithdrawal(ctx, created.enrollment_id, withdrawal);
    throw redactError(withWithdrawal(error, created.enrollment_id, withdrawal), token);
  }
}

/**
 * Says on standard error what became of the enrollment, whether or not it is a terminal: the run
 * is failing, and the line is the record of it (`pidgen setup` keeps it in its log).
 */
function noteWithdrawal(ctx: RunContext, enrollmentId: string, withdrawal: Withdrawal): void {
  if (withdrawal.withdrawn) {
    ctx.io.stderr(`Withdrew the enrollment ${enrollmentId}, so nothing is left waiting.\n`);
  } else {
    ctx.io.stderr(
      `Could not withdraw the enrollment ${enrollmentId} (${withdrawal.error.code}: ${withdrawal.error.message}); it expires on its own.\n`,
    );
  }
}

/**
 * The failure after an enrollment was created, saying what became of it: `withdrawn` in its
 * details (and `withdraw_error` when the withdraw failed) and a sentence in its message. Its code
 * and exit code stay. Anything but a `CliError` is passed through.
 */
function withWithdrawal(error: unknown, enrollmentId: string, withdrawal: Withdrawal): unknown {
  if (!(error instanceof CliError)) return error;
  const sentence = withdrawal.withdrawn
    ? `The enrollment ${enrollmentId} was withdrawn.`
    : `The enrollment ${enrollmentId} could not be withdrawn and expires on its own.`;
  return new CliError(error.code, `${error.message} ${sentence}`, error.exitCode, {
    ...error.details,
    withdrawn: withdrawal.withdrawn,
    ...(withdrawal.withdrawn
      ? {}
      : {
          withdraw_error: { code: withdrawal.error.code, message: withdrawal.error.message },
        }),
  });
}

/** The server's refusal of an enrollment's name (HTTP 409 on `POST /workers/enrollments`). */
export const NAME_TAKEN = "WORKER_NAME_TAKEN";

/**
 * `WORKER_NAME_TAKEN`: the server refused the enrollment's name because the Account holds it, by a
 * live worker or a pending enrollment (another person's pending enrollments are not visible to the
 * CLI). No enrollment was created. `error.details` carries the server's `display_name` and
 * `suggested_name`, a name it would accept.
 */
function nameTaken(refusal: CliError, label: string | undefined): CliError {
  const given = refusal.details["display_name"];
  const suggestion = refusal.details["suggested_name"];
  const name = typeof given === "string" && given !== "" ? given : (label ?? null);
  // The server's suggestion, made into a name the rule accepts, so the command it names works.
  const suggested =
    typeof suggestion === "string" && suggestion.trim() !== ""
      ? suggestWorkerName(suggestion)
      : null;
  const other = displayArgument(suggested ?? "<name>");
  return new CliError(
    NAME_TAKEN,
    `Pidgen refused to enroll a worker named ${name ?? "(no name)"}: the Account already has a worker or a pending enrollment by that name (HTTP 409 WORKER_NAME_TAKEN). No enrollment was created. Enroll under another name: \`pidgen worker enroll --label ${other} -- --host-id ${other}\`, or run \`pidgen setup\`, which asks for one.`,
    ExitCode.Refused,
    { ...refusal.details, display_name: name, suggested_name: suggested },
  );
}

/**
 * `WORKER_HOST_TAKEN`: the server refused the worker's host id because a worker holds it, in this
 * Account or another (host ids are unique across Accounts).
 */
function hostTaken(hostId: string | null, details: Record<string, unknown>): CliError {
  const name = hostId ?? "this worker's host id";
  const other =
    hostId === null ? "<name>" : displayArgument(numberedWorkerName(suggestWorkerName(hostId), 2));
  return new CliError(
    "WORKER_HOST_TAKEN",
    `Pidgen refused to enroll ${hostId === null ? name : `host id ${hostId}`}: it is taken by another worker, in this Account or another (HTTP 409 WORKER_HOST_TAKEN). Enroll under another name: \`pidgen worker enroll --label ${other} -- --host-id ${other}\`, or run \`pidgen setup\`, which picks a free one.`,
    ExitCode.Refused,
    { ...details, host_id: hostId },
  );
}

/** The longest name a worker may have: the server refuses a longer host id. */
export const WORKER_NAME_MAX = 93;

/** The rule a worker's name, its enrollment's label and host id, must match (the server's). */
const WORKER_NAME_RULE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${WORKER_NAME_MAX - 1}}$`);

/** The rule in plain words. */
export const WORKER_NAME_RULE_TEXT = `A worker's name starts with a letter or a number and uses only letters, numbers, ".", "_" and "-", at most ${WORKER_NAME_MAX} characters.`;

/**
 * A name as the worker will have it: ends trimmed, and each run of spaces replaced by one "-".
 * Every place the CLI takes a worker's name (`pidgen setup`'s question and `--label`,
 * `pidgen worker enroll --label` and `--host-id`) normalizes it with this, then checks it with
 * `workerNameProblem`, so the three cannot drift.
 */
export function normalizeWorkerName(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}

/**
 * Why `name`, normalized, cannot be a worker's name, in words that say how to change it (the
 * characters not allowed, the part of the rule it breaks, the rule and a name that would work), or
 * `null` when the rule accepts it.
 */
export function workerNameProblem(name: string): string | null {
  if (WORKER_NAME_RULE.test(name)) return null;
  const example = suggestWorkerName(name);
  const characters = [...name];
  if (characters.length === 0) {
    return `A worker needs a name. ${WORKER_NAME_RULE_TEXT} For example: ${example}.`;
  }
  const breaks: string[] = [];
  const refused = [...new Set(characters.filter((character) => !/[A-Za-z0-9._-]/.test(character)))];
  if (refused.length > 0) {
    const listed = refused.map((character) => `"${character}"`);
    const list =
      listed.length === 1
        ? listed[0]!
        : `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]!}`;
    breaks.push(`${list} ${refused.length === 1 ? "is" : "are"} not allowed`);
  }
  if (/^[._-]/.test(name)) breaks.push(`it starts with "${name[0]!}", not a letter or a number`);
  if (characters.length > WORKER_NAME_MAX) {
    breaks.push(`it is ${characters.length} characters long`);
  }
  return `${name} can't be a worker's name: ${breaks.join("; ")}. ${WORKER_NAME_RULE_TEXT} For example: ${example}.`;
}

/**
 * A name the rule accepts, made from `name` (a host name, or a name the rule refuses): spaces and
 * each run of other refused characters become one "-", a leading ".", "_" or "-" is dropped, and it
 * is cut to the limit. A name the rule accepts is returned as it is; one with nothing left is
 * `worker`.
 */
export function suggestWorkerName(name: string): string {
  const normalized = normalizeWorkerName(name);
  if (WORKER_NAME_RULE.test(normalized)) return normalized;
  const made = normalized
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, WORKER_NAME_MAX)
    .replace(/-+$/, "");
  return made === "" ? "worker" : made;
}

/** `<name>-<number>`, `name` cut so the result stays within the limit. */
export function numberedWorkerName(name: string, number: number): string {
  const suffix = `-${number}`;
  return `${name.slice(0, WORKER_NAME_MAX - suffix.length)}${suffix}`;
}

/** Refuses a name given on the command line that the rule refuses, before anything is done. */
function requireWorkerName(flag: string, name: string): void {
  const problem = workerNameProblem(name);
  if (problem !== null) {
    throw usageError(`${flag}: ${problem}`, { name, example: suggestWorkerName(name) });
  }
}

/** `args` with the host id they give pidgen-worker, each one, normalized as a worker's name. */
function withNormalizedHostId(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === "--host-id") return normalizeWorkerName(arg);
    if (arg.startsWith("--host-id=")) {
      return `--host-id=${normalizeWorkerName(arg.slice("--host-id=".length))}`;
    }
    return arg;
  });
}

/** What to do after a refusal Pidgen should not have made: update the worker, then report it. */
const UPDATE_HINT =
  "Update the worker with `pidgen worker update` and enroll again; if it still fails, report it with `pidgen feedback --kind not-working`.";

/** The worker's fallback sentence, which names only an HTTP status (and code). */
const BARE_REFUSAL = /^the enrollment was refused: HTTP \d{3}(?: [A-Z][A-Z0-9_]*)?\.?$/;

/**
 * `ENROLL_FAILED` for a `pidgen-worker enroll` run that failed for a reason other than a taken
 * host id: the message says what happened and what to do next, never a bare HTTP status.
 * `details.hint` is the next step and `details.refusal` the worker's reason as it printed it.
 */
function enrollFailed(run: WorkerEnrollResult, details: Record<string, unknown>): CliError {
  const refusal = run.refusal;
  let message: string;
  let hint: string;
  if (refusal === null) {
    hint =
      "Read pidgen-worker's output above (`pidgen setup` keeps all of it in its log) for what went wrong; if it does not say, report it with `pidgen feedback --kind not-working`.";
    message = `pidgen-worker enroll exited with status ${run.status} without saying why. ${hint}`;
  } else if (BARE_REFUSAL.test(refusal.reason)) {
    const status = refusal.http_status ?? 0;
    if (status >= 500) {
      hint = "Try again in a few minutes.";
      message = `Pidgen's server had a problem and could not finish the enrollment. ${hint}`;
    } else {
      hint = UPDATE_HINT;
      message = `Pidgen did not accept the enrollment request pidgen-worker sent. This is not caused by anything you entered: this worker may be too old for the server. ${hint}`;
    }
  } else {
    hint =
      "Enroll again; if it fails the same way, report it with `pidgen feedback --kind not-working`.";
    // The worker's own sentence already says what happened: it is repeated as the worker said it.
    const said = refusal.service_message === null ? "" : ` Pidgen said: ${refusal.service_message}`;
    message = `pidgen-worker enroll: ${refusal.reason}${said} ${hint}`;
  }
  return new CliError("ENROLL_FAILED", message, ExitCode.Unexpected, {
    ...details,
    hint,
    refusal,
  });
}

/** The host id `args` give pidgen-worker (`--host-id <id>` or `--host-id=<id>`, the last wins). */
function hostIdOf(args: readonly string[]): string | null {
  let found: string | null = null;
  args.forEach((arg, index) => {
    if (arg === "--host-id" && index + 1 < args.length) found = args[index + 1]!;
    else if (arg.startsWith("--host-id=")) found = arg.slice("--host-id=".length);
  });
  return found;
}

/** `args` with the host id they give pidgen-worker replaced by `hostId`, or added. */
function withHostId(args: readonly string[], hostId: string): string[] {
  const out = [...args];
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index] === "--host-id" && index + 1 < out.length) {
      out[index + 1] = hostId;
      return out;
    }
    if (out[index]!.startsWith("--host-id=")) {
      out[index] = `--host-id=${hostId}`;
      return out;
    }
  }
  return [...out, "--host-id", hostId];
}

/** `WORKER_CREDENTIAL_PRESENT`: the worker home holds a credential and it was not to be replaced. */
function credentialPresent(path: string): CliError {
  return new CliError(
    "WORKER_CREDENTIAL_PRESENT",
    `${path} already holds a worker credential, and pidgen-worker would use it instead of a new enrollment, so none was created. Run \`${START_COMMAND}\` to use the saved credential, or pass --replace-credential to move it aside and enroll anew.`,
    ExitCode.Refused,
    { path, start: { command: START_COMMAND } },
  );
}

/**
 * Runs `pidgen worker install`'s install for a missing worker, once `--install` or `--no-install`
 * has decided. Returns the install record.
 */
async function installMissingWorker(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
  install: boolean | undefined,
): Promise<InstallRecord> {
  if (install === false) {
    throw new CliError(
      "WORKER_NOT_FOUND",
      `pidgen-worker is not installed and --no-install was given. Run \`${INSTALL_COMMAND}\`, then enroll again.`,
      ExitCode.Usage,
      { install: { command: INSTALL_COMMAND } },
    );
  }
  const { record } = await installWorker(ctx, global, {
    force: false,
    beforeInstall: (release, list) => {
      requireInstallAgreement(install, release, list);
      return Promise.resolve();
    },
  });
  return record;
}

/**
 * Lets the install go ahead only when `--install` agreed in advance. Nothing asks: without the flag
 * it stops before anything is downloaded or run, on a terminal or not.
 */
function requireInstallAgreement(
  install: boolean | undefined,
  release: ResolvedRelease,
  list: WorkerReleaseList,
): void {
  if (install === true) return;
  throw new CliError(
    "INSTALL_CONFIRMATION_REQUIRED",
    "pidgen-worker is not installed. Run `pidgen setup`, which installs and verifies it before enrolling, or pass --install to install it here, or --no-install.",
    ExitCode.Usage,
    {
      install: { command: INSTALL_COMMAND },
      release: { version: release.version, artifact: release.wheel?.requirement ?? null },
      eula: list.eula,
    },
  );
}

function enrollmentSummary(created: CreatedEnrollment) {
  return {
    enrollment_id: created.enrollment_id,
    account_id: created.account_id,
    label: created.label,
    fingerprint: created.fingerprint,
    created_by: created.created_by,
    created_at: created.created_at,
    expires_at: created.expires_at,
    state: created.state,
  };
}

function reportedOption(option: InstallOption): ReportedInstallOption {
  return { form: option.form, artifact: option.artifact, install: option.install };
}

function progress(ctx: RunContext, text: string): void {
  if (ctx.io.interactive) ctx.io.stderr(text);
}

/** Replaces every occurrence of the one-time token in `value`'s strings. */
export function redact<T>(value: T, token: string): T {
  if (token === "") return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return item.split(token).join(REDACTED);
    if (Array.isArray(item)) return item.map(walk);
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    }
    return item;
  };
  return walk(value) as T;
}

function redactError(error: unknown, token: string): unknown {
  if (error instanceof CliError) {
    return new CliError(
      error.code,
      redact(error.message, token),
      error.exitCode,
      redact(error.details, token),
    );
  }
  if (error instanceof Error && error.message.includes(token)) {
    return new Error(redact(error.message, token));
  }
  return error;
}
