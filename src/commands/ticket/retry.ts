import { addRecoveryOptions, runRecovery } from "../../core/recovery.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen ticket retry <ref> [--run <id>]`: reads the ticket's recovery decisions
 * (`GET /tickets/{ref}/actions?family=recovery`) and previews `retry_run` — or
 * `restart_refinement` for a Refinery run when the decision says so — with
 * `POST /tickets/{ref}/actions/preview`; only with `--apply` it executes it
 * (`POST /tickets/{ref}/actions/execute`), following a `202`'s `status_url` with `--wait`. Without
 * `--run` it recovers the run the server's first decision names, the newest. See docs/commands.md,
 * "ticket retry and replay".
 */
export const ticketRetry: CommandSpec = {
  path: ["ticket", "retry"],
  summary: "Preview, then with --apply start a fresh attempt of a ticket's run",
  configure(command) {
    addRecoveryOptions(command, false);
  },
  run(ctx, input) {
    return runRecovery(ctx, input, "ticket retry", "retry");
  },
};
