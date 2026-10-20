import { CliError } from "../../core/errors.js";
import type { CommandSpec } from "../../core/registry.js";
import { installedAdapter, restartDetached } from "../../core/worker-install.js";

const START = "pidgen worker start --detach";

/**
 * `pidgen worker restart [--force]`: stops the detached worker (or the `pidgen-worker` container)
 * as `worker stop` does and starts it detached again with the arguments it was started with, with
 * the startup check of `worker start --detach`. It takes no `-- args`: a person who wants other
 * arguments runs `worker stop`, then `worker start --detach -- <args>`. A foreground worker has no
 * run record and is its owner's to restart.
 *
 * `data` is `stopped` (what `worker stop` reports for the old worker), `record` (the new run record)
 * and `running: true`.
 */
export const workerRestart: CommandSpec = {
  path: ["worker", "restart"],
  summary: "Restart the detached worker with the arguments it was started with",
  configure(command) {
    command.option("--force", "kill the worker if it does not stop before the timeout", false);
  },
  async run(ctx, { options, global }) {
    const adapter = await installedAdapter(ctx);
    try {
      const { stopped, record } = await restartDetached(adapter, {
        force: options["force"] === true,
        timeoutSeconds: global.timeoutSeconds,
      });
      return { data: { stopped, record, running: true } };
    } catch (error) {
      throw error instanceof CliError && error.code === "WORKER_NOT_RUNNING"
        ? notRunning(error)
        : error;
    }
  },
};

/** `worker stop`'s refusal, naming how to start the worker when its message does not. */
function notRunning(error: CliError): CliError {
  if (error.message.includes(START)) return error;
  return new CliError(
    error.code,
    `${error.message} Start it with \`${START}\`.`,
    error.exitCode,
    error.details,
  );
}
