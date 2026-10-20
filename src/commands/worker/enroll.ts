import type { Command } from "commander";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { validateBody } from "../../core/input.js";
import { ensureInstallId, invalidInstallIdNote } from "../../core/install-id.js";
import type { CommandInput, CommandResult, CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import {
  findWorker,
  moveWorkerCredentialAside,
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
}

/** `pidgen worker enroll`, with the hooks an in-process caller may give. */
export async function enrollWorker(
  ctx: RunContext,
  { args: given, options, global }: CommandInput,
  hooks: EnrollHooks = {},
): Promise<CommandResult> {
  let args = [...given];
  const install = typeof options["install"] === "boolean" ? options["install"] : undefined;
  const label = typeof options["label"] === "string" ? options["label"] : undefined;
  const replace = options["replaceCredential"] === true;
  const body = label === undefined ? {} : { label };
  // A label the contract refuses is refused before anything is installed or created.
  validateBody(WORKER_ENROLLMENTS_DOCUMENT, ENROLL_ROUTE.method, ENROLL_ROUTE.path, body);

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
      if (!run.hostTaken) {
        throw new CliError(
          "ENROLL_FAILED",
          `pidgen-worker enroll exited with status ${run.status}.`,
          ExitCode.Unexpected,
          { ...report, exit_code: run.status, worker },
        );
      }
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
  const suggested = typeof suggestion === "string" && suggestion.trim() !== "" ? suggestion : null;
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
  const other = hostId === null ? "<name>" : displayArgument(`${hostId}-2`);
  return new CliError(
    "WORKER_HOST_TAKEN",
    `Pidgen refused to enroll ${hostId === null ? name : `host id ${hostId}`}: it is taken by another worker, in this Account or another (HTTP 409 WORKER_HOST_TAKEN). Enroll under another name: \`pidgen worker enroll --label ${other} -- --host-id ${other}\`, or run \`pidgen setup\`, which picks a free one.`,
    ExitCode.Refused,
    { ...details, host_id: hostId },
  );
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
