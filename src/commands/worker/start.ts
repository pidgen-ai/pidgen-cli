import type { CommandSpec } from "../../core/registry.js";
import { installedAdapter } from "../../core/worker-install.js";

/**
 * `pidgen worker start [--detach] [-- args]`: runs the installed worker. The install record's
 * form selects the runtime: the wheel runs `pidgen-worker` (found on `PATH` or at
 * `PIDGEN_WORKER_BIN` when nothing is recorded); the container runs the verified image as the
 * named container `pidgen-worker`, with the worker home in a Docker volume.
 */
export const workerStart: CommandSpec = {
  path: ["worker", "start"],
  summary: "Run the worker",
  configure(command) {
    command.option("--detach", "run the worker in the background", false).argument("[args...]");
  },
  async run(ctx, { args, options }) {
    const adapter = await installedAdapter(ctx);
    if (options["detach"] === true) {
      const record = await adapter.start(args, true);
      return { data: { record, running: true } };
    }
    const exitCode = await adapter.start(args, false);
    return { exitCode: typeof exitCode === "number" ? exitCode : 0, envelope: false };
  },
};
