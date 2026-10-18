import type { Command } from "commander";
import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import type { GlobalOptions, RunContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import { validateBody } from "../../core/input.js";
import type { CommandSpec } from "../../core/registry.js";
import { openSession } from "../../core/session.js";
import { findWorker, runWorkerEnroll } from "../../core/worker.js";
import { installWorker, type InstallRecord } from "../../core/worker-install.js";
import type { ResolvedRelease } from "../../core/worker-index.js";
import type { WorkerReleaseList } from "../../core/worker-releases.js";
import type { components } from "../../generated/api.js";

type CreatedEnrollment = components["schemas"]["CreatedEnrollment"];
type InstallOption = components["schemas"]["InstallOption"];

/** The operation `worker enroll` sends, as the public API document names it. */
export const ENROLL_ROUTE = { method: "post", path: "/workers/enrollments" } as const;

/** The command that installs the worker on its own; `worker enroll` runs the same install. */
const INSTALL_COMMAND = "pidgen worker install";

const REDACTED = "[redacted]";

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
 */
export const workerEnroll: CommandSpec = {
  path: ["worker", "enroll"],
  summary: "Install the worker with --install, create an enrollment, and run pidgen-worker enroll",
  configure(command: Command) {
    command
      .option("--label <label>", "a name for the enrollment, shown in lists")
      .option("--install", "install the worker without asking when it is missing")
      .option("--no-install", "never install the worker; fail when it is missing")
      .argument("[args...]");
  },
  async run(ctx, { args, options, global }) {
    const install = typeof options["install"] === "boolean" ? options["install"] : undefined;
    const label = typeof options["label"] === "string" ? options["label"] : undefined;
    const body = validateBody(
      PUBLIC_API_DOCUMENT,
      ENROLL_ROUTE.method,
      ENROLL_ROUTE.path,
      label === undefined ? {} : { label },
    );

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

    // Only now, with a verified worker present, is the enrollment created.
    const session = await openSession(ctx, global);
    const response = await session.client.request<CreatedEnrollment>({
      method: "POST",
      path: ENROLL_ROUTE.path,
      body,
    });
    const created = response.data;
    const token = created.token;
    const report = {
      enrollment: enrollmentSummary(created),
      install: created.install.map(reportedOption),
      eula: created.eula,
    };

    try {
      progress(ctx, `Enrolling with ${worker}\n`);
      const server = session.target.url;
      const status = await runWorkerEnroll(ctx, worker, token, server, args, ctx.workerRuntime);
      if (status !== ExitCode.Ok) {
        throw new CliError(
          "ENROLL_FAILED",
          `pidgen-worker enroll exited with status ${status}.`,
          ExitCode.Unexpected,
          { ...report, exit_code: status, worker },
        );
      }
      return {
        data: redact({ ...report, installed, worker, enrolled: true }, token),
        meta: session.meta(response),
      };
    } catch (error) {
      throw redactError(error, token);
    }
  },
};

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
