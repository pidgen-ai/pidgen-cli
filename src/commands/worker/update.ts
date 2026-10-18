import type { Command } from "commander";
import type { RunContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";
import { assertSupportedPlatform } from "../../core/worker.js";
import {
  adapterFor,
  noInstallRecord,
  readInstallRecord,
  removeKeptArtifact,
  retireSharedInstall,
  writeInstallRecord,
  type InstallRecord,
  licenceNotice,
  type RunRecord,
  type WorkerAdapter,
} from "../../core/worker-install.js";
import { renderLifecycle } from "../../core/lifecycle-human.js";
import { packageIndex, resolveRelease, resolveUpdate, trackOf } from "../../core/worker-index.js";
import { readWorkerReleases, selectSeries } from "../../core/worker-releases.js";
import { optionalVersion } from "./install.js";

/**
 * `pidgen worker update [--version <version>] [--restart] [--test]`: installs `--version`, or else
 * the newest release of the server's `current` series on the installed version's track when it is
 * newer than the installed one (`resolveUpdate`: final releases, and pre-releases too while a
 * pre-release is installed; never an older release), in the recorded form with the same
 * verification as `worker install`, and updates the install record. `--test`, or an install that
 * came from TestPyPI, looks there for rehearsals. Nothing updates on its own. When nothing is
 * newer it installs nothing and, in a terminal, says the installed version is the newest on its
 * track.
 *
 * A worker started with `--detach` (or its container) keeps running the old version unless
 * `--restart` is given: then it is stopped after the install and started again with the same
 * arguments. If the new worker exits during the startup check, the previous version is reinstalled
 * (the kept wheel after its recorded digest is checked; the image after its signature verifies
 * again), the record restored, the worker started again on it, and the command exits 1 with
 * `UPDATE_ROLLED_BACK`.
 *
 * `data` is the new install record plus `updated`, `previous_version`, `running`, `restarted` and,
 * when it was restarted, the detached worker's (or container's) `record` under `worker`.
 */
export const workerUpdate: CommandSpec = {
  path: ["worker", "update"],
  summary:
    "Install the server's current (or a named) worker release, verified, and optionally restart",
  configure(command: Command) {
    command
      .option("--version <version>", "a release of a series the server accepts")
      .option("--restart", "restart a detached worker on the new version", false)
      .option("--test", "update from TestPyPI, where release rehearsals are published", false);
  },
  async run(ctx, { options, global }) {
    assertSupportedPlatform(ctx.workerRuntime);
    const version = optionalVersion(options["version"]);
    const restart = options["restart"] === true;
    const previous = await readInstallRecord(ctx);
    if (previous === null) throw noInstallRecord();

    const { list, meta } = await readWorkerReleases(ctx, global);
    const series = selectSeries(list, version);
    const index = packageIndex(options["test"] === true || previous.index === "testpypi");
    // Without --version, only a newer release on the installed version's track: never backwards.
    const release =
      version !== undefined
        ? await resolveRelease(ctx, series, index, version)
        : await resolveUpdate(ctx, series, index, previous.version);
    const adapter = adapterFor(ctx, previous.form);
    if (release === null || previous.version === release.version) {
      const { running } = await adapter.status();
      const data = {
        ...previous,
        updated: false,
        previous_version: previous.version,
        running,
        restarted: false,
      };
      if (release !== null) return { data, meta };
      const newest = `pidgen-worker ${previous.version} is already the newest on its track: ${trackOf(previous.version, index, series.series)}.`;
      const human = renderLifecycle("worker update", data, ctx.io.stdoutColumns, undefined, [
        newest,
      ]);
      return { data, meta, ...(human !== undefined ? { human } : {}) };
    }

    await adapter.prerequisite();
    ctx.io.stderr(licenceNotice(list.eula));
    const installed = await adapter.install(release, { reinstall: true });
    await writeInstallRecord(ctx, installed);

    const local = await adapter.status();
    if (!restart || !local.running || local.record === null) {
      await dropSuperseded(previous, installed);
      await retireSharedInstall(ctx, previous, local);
      return {
        data: {
          ...installed,
          updated: true,
          previous_version: previous.version,
          running: local.running,
          restarted: false,
        },
        meta,
      };
    }

    const args = workerArgs(local.record);
    await adapter.stop(false, global.timeoutSeconds);
    let started: RunRecord;
    try {
      started = await startDetached(adapter, args);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return await rollBack(ctx, adapter, previous, installed, args, error);
    }
    await dropSuperseded(previous, installed);
    // Nothing runs from the previous install now.
    await retireSharedInstall(ctx, previous, null);
    return {
      data: {
        ...installed,
        updated: true,
        previous_version: previous.version,
        running: true,
        restarted: true,
        worker: started,
      },
      meta,
    };
  },
};

async function startDetached(adapter: WorkerAdapter, args: readonly string[]): Promise<RunRecord> {
  return (await adapter.start(args, true)) as RunRecord;
}

/** The arguments the running worker was started with: after the command, or the container's. */
function workerArgs(record: RunRecord): string[] {
  return "command" in record ? record.command.slice(1) : record.args;
}

/** The superseded install's kept wheel is removed once the new one is in place. */
async function dropSuperseded(previous: InstallRecord, installed: InstallRecord): Promise<void> {
  if (previous.file !== installed.file) await removeKeptArtifact(previous);
}

/**
 * The new worker did not start: reinstall the previous version, restore its record, start it again,
 * and fail with `UPDATE_ROLLED_BACK` (or `ROLLBACK_FAILED` when the previous version cannot be
 * reinstalled).
 */
async function rollBack(
  ctx: RunContext,
  adapter: WorkerAdapter,
  previous: InstallRecord,
  installed: InstallRecord,
  args: readonly string[],
  failure: CliError,
): Promise<never> {
  const attempt = {
    version: installed.version,
    previous_version: previous.version,
    cause: failure.code,
    log_tail: logTail(failure),
  };
  ctx.io.stderr(
    `pidgen-worker ${installed.version} did not start (${failure.code}); reinstalling ${previous.version}.\n`,
  );
  try {
    await adapter.reinstall(previous);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(
      "ROLLBACK_FAILED",
      `pidgen-worker ${installed.version} exited during startup, and ${previous.version} could not be reinstalled: ${error.message} Run \`pidgen worker install --version ${previous.version}\`.`,
      ExitCode.Unexpected,
      {
        ...attempt,
        rollback: { code: error.code, message: error.message, details: error.details },
      },
    );
  }
  // The wheel was reinstalled into the worker home's tool environment, where the new one was.
  const restored: InstallRecord =
    previous.form === "wheel" ? { ...previous, location: installed.location } : previous;
  await writeInstallRecord(ctx, restored);
  if (previous.file !== installed.file) await removeKeptArtifact(installed);

  let worker: RunRecord | null = null;
  let restartError: { code: string; message: string } | null = null;
  try {
    worker = await startDetached(adapter, args);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    restartError = { code: error.code, message: error.message };
  }
  throw new CliError(
    "UPDATE_ROLLED_BACK",
    worker !== null
      ? `pidgen-worker ${installed.version} exited during startup; ${previous.version} was reinstalled and restarted.`
      : `pidgen-worker ${installed.version} exited during startup; ${previous.version} was reinstalled but did not restart (${restartError?.code}).`,
    ExitCode.Unexpected,
    {
      ...attempt,
      record: restored,
      running: worker !== null,
      worker,
      ...(restartError !== null ? { restart_error: restartError } : {}),
    },
  );
}

function logTail(error: CliError): string[] {
  const tail = error.details["log_tail"];
  return Array.isArray(tail) ? tail.filter((line): line is string => typeof line === "string") : [];
}
