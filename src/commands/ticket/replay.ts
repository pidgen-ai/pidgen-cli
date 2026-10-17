import { addRecoveryOptions, runRecovery } from "../../core/recovery.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen ticket replay <ref> --node <id> [--run <id>]`: reads the ticket's recovery decisions for
 * the node (`GET /tickets/{ref}/actions?family=recovery&node_id=…`) and previews its
 * `replay_from_node` — re-running the node and what depends on it — with
 * `POST /tickets/{ref}/actions/preview`; only with `--apply` it executes it
 * (`POST /tickets/{ref}/actions/execute`), following a `202`'s `status_url` with `--wait`. See
 * docs/commands.md, "ticket retry and replay".
 */
export const ticketReplay: CommandSpec = {
  path: ["ticket", "replay"],
  summary: "Preview, then with --apply replay a ticket's run from one node",
  configure(command) {
    addRecoveryOptions(command, true);
  },
  run(ctx, input) {
    return runRecovery(ctx, input, "ticket replay", "replay");
  },
};
