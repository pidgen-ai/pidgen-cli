import { PUBLIC_API_DOCUMENT } from "../api/document.js";
import { checkContract } from "../../core/contract.js";
import type { CommandSpec } from "../../core/registry.js";
import { skillsStatus, type Agent, type Scope } from "../../core/skills.js";
import { agentOption, scopeOption } from "./install.js";

/**
 * `pidgen skills status [--agent …] [--scope …]`: `data.skills` reports each installed skill as
 * `current`, `stale`, `edited` or `missing`; `data.contract` compares the CLI's committed public API
 * document with the configured server's (`GET /api/v1/openapi.json`, sent without a credential):
 * `same`, `different` (with the operations only one side has), or `unchecked` with the `reason` the
 * server's document could not be read. The comparison never fails the command.
 */
export const skillsStatusCommand: CommandSpec = {
  path: ["skills", "status"],
  summary: "Report installed skills that are stale, edited, or missing, and contract drift",
  configure(command) {
    command.addOption(agentOption()).addOption(scopeOption());
  },
  async run(ctx, { options, global }) {
    const skills = await skillsStatus(ctx, {
      agent: options["agent"] as Agent | "all",
      scope: options["scope"] as Scope,
    });
    const contract = await checkContract(ctx, global, PUBLIC_API_DOCUMENT);
    return { data: { skills, contract } };
  },
};
