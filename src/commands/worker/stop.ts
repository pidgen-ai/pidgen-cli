import type { CommandSpec } from "../../core/registry.js";
import { installedAdapter } from "../../core/worker-install.js";

/** `pidgen worker stop [--force]`: stops the detached worker, or the worker's container. */
export const workerStop: CommandSpec = {
  path: ["worker", "stop"],
  summary: "Stop the detached worker",
  configure(command) {
    command.option("--force", "kill the worker if it does not stop before the timeout", false);
  },
  async run(ctx, { options, global }) {
    const adapter = await installedAdapter(ctx);
    return { data: await adapter.stop(options["force"] === true, global.timeoutSeconds) };
  },
};
