import { rm } from "node:fs/promises";
import { resolve, parse } from "node:path";
import type { Command } from "commander";
import type { RunContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";
import {
  assertSupportedPlatform,
  removeWorkerRecord,
  resolvePidgenHome,
} from "../../core/worker.js";
import {
  adapterFor,
  noInstallRecord,
  readInstallRecord,
  removeInstallRecord,
} from "../../core/worker-install.js";

/**
 * `pidgen worker uninstall [--purge]`: stops a detached worker (or its container), removes what
 * the install record's form installed, and the install record. The wheel runs `uv tool uninstall
 * pidgen-worker` and removes the kept wheel; the container removes the `pidgen-worker` container
 * and the pinned image. The worker home, with the worker's credential, stays unless `--purge` is
 * given: then the worker home is removed, and for the container also the `pidgen-worker-home`
 * Docker volume that holds the container's worker home. A stale detached run record (a recorded
 * worker that is no longer running) is removed too, so `worker status` then reports `record: null`.
 * No install record exits 4 with `WORKER_NOT_INSTALLED`.
 *
 * `data` is `uninstalled` (the removed install record), `stopped` (`{record, forced}` of the
 * worker it stopped, or `null`), `removed` (what was removed, such as `tool pidgen-worker` or
 * `image <reference>@<digest>`), `purged` and `worker_home`.
 */
export const workerUninstall: CommandSpec = {
  path: ["worker", "uninstall"],
  summary: "Stop a detached worker and remove the installed worker and its install record",
  configure(command: Command) {
    command.option("--purge", "also remove the worker home, with the worker's credential", false);
  },
  async run(ctx, { options, global }) {
    assertSupportedPlatform(ctx.workerRuntime);
    const purge = options["purge"] === true;
    const record = await readInstallRecord(ctx);
    if (record === null) throw noInstallRecord();
    const home = resolvePidgenHome(ctx);
    if (purge) assertPurgeable(ctx, home);

    const adapter = adapterFor(ctx, record.form);
    const local = await adapter.status();
    // The tool is being removed, so a worker that does not stop within the timeout is killed.
    const stopped = local.running ? await adapter.stop(true, global.timeoutSeconds) : null;
    // A detached worker that exited on its own left its run record; it goes with the install.
    if (!local.running && local.record !== null && record.form === "wheel") {
      await removeWorkerRecord(ctx);
    }
    const { removed } = await adapter.uninstall(record, purge);
    await removeInstallRecord(ctx);
    if (purge) await rm(home, { recursive: true, force: true });

    return { data: { uninstalled: record, stopped, removed, purged: purge, worker_home: home } };
  },
};

/** `--purge` removes the worker home; never when it is the home directory or a filesystem root. */
function assertPurgeable(ctx: RunContext, home: string): void {
  const target = resolve(ctx.cwd, home);
  if (target === resolve(ctx.homeDir) || target === parse(target).root) {
    throw new CliError(
      "PURGE_REFUSED",
      `The worker home ${target} is not a directory of its own, so --purge will not remove it. Unset PIDGEN_HOME or point it at the worker's own directory.`,
      ExitCode.Refused,
      { worker_home: target },
    );
  }
}
