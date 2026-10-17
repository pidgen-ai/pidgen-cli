import {
  CONTRACT_ROUTES,
  contractArgument,
  contractRequest,
  contractSegment,
} from "../../core/contracts.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen contract show <contract>`: one contract, by key (`CT-7`) or id
 * (`GET /contracts/{contract_id}`). `data` is the server's contract unchanged: its `provider` (a
 * project or a domain: `project_id`, `kind`, `domain_id`, `key`, `name`), `owner_user_id`, `status`
 * and `implemented`; its `revisions`, each with its `kind`, `change`, `operations`, Markdown,
 * native schema and how it was accepted (`acceptance` `waiting`, `automatic` or `person`, with
 * `accepted_by` and `accepted_at`); and the work that implements it (`implemented_by`) and builds
 * against it (`built_against_by`), each the Tickets you can see in `work` and `hidden_count`, a
 * count of the rest; and `operation_states`, each operation by `name` with its `state`: `landed`
 * (in the newest published revision), `pending` (in an accepted proposed revision, not yet
 * published) or `removed` (in an earlier published revision and not the newest). The read is
 * checked against the published document: a body that does not match is `UNEXPECTED_RESPONSE`
 * (exit 1); an unknown contract is `CONTRACT_NOT_FOUND` (exit 4).
 */
export const contractShow: CommandSpec = {
  path: ["contract", "show"],
  summary:
    "Show one contract: its revisions, each operation's state, how each was accepted, and the work linked to it",
  configure: contractArgument,
  async run(ctx, { args, global }) {
    return contractRequest(ctx, global, CONTRACT_ROUTES.show, {
      contract_id: contractSegment(args),
    });
  },
};
