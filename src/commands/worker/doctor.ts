import type { CommandSpec } from "../../core/registry.js";
import { installedAdapter } from "../../core/worker-install.js";

/**
 * `pidgen worker doctor [-- args]`: the installed worker's own checks, `pidgen-worker doctor
 * --json`, run directly for the wheel or with `docker exec` in the worker's container.
 */
export const workerDoctor: CommandSpec = {
  path: ["worker", "doctor"],
  summary: "Run the worker's diagnostic checks",
  configure(command) {
    command.argument("[args...]");
  },
  async run(ctx, input) {
    const adapter = await installedAdapter(ctx);
    return { data: await adapter.doctor(input.args) };
  },
};
