import type { CommandSpec } from "../../core/registry.js";
import { installedAdapter } from "../../core/worker-install.js";

/**
 * `pidgen worker dashboard [--no-open] [-- args]`: runs the installed worker's `pidgen-worker dashboard` in the
 * foreground, the way foreground `worker start` does: inherited standard streams, forwarded
 * signals, no envelope, and the worker's exit status. The worker serves a local page behind a
 * single-use link it prints. By default the CLI passes the worker's `--open`, right after
 * `dashboard`, so the worker opens the page in the browser itself (once, even when the caller
 * also passes `--open` after `--`); `--no-open` leaves it out. It is a separate process from any running worker and writes no run
 * record. A container install is refused (`DASHBOARD_UNSUPPORTED`). A worker release from before
 * the dashboard exits 2 with its usage, so that status adds one hint line on standard error.
 */
export const workerDashboard: CommandSpec = {
  path: ["worker", "dashboard"],
  summary: "Open the worker's local dashboard in your browser",
  configure(command) {
    command
      .option("--no-open", "print the dashboard link without opening the browser")
      .argument("[args...]");
  },
  async run(ctx, { args, options }) {
    const adapter = await installedAdapter(ctx);
    const exitCode = await adapter.dashboard(
      options["open"] === false || args.includes("--open") ? args : ["--open", ...args],
    );
    if (exitCode === 2) {
      ctx.io.stderr(
        "If pidgen-worker did not recognise `dashboard`, update it with `pidgen worker update --restart`.\n",
      );
    }
    return { exitCode, envelope: false };
  },
};
