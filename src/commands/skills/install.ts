import { Option } from "commander";
import type { CommandSpec } from "../../core/registry.js";
import { AGENTS, installSkills, type Agent, type Scope } from "../../core/skills.js";
import { CLI_VERSION } from "../../core/version.js";

export const agentOption = () =>
  new Option("--agent <agent>", "agent to install for")
    .choices([...Object.keys(AGENTS), "all"])
    .default("all");

export const scopeOption = () =>
  new Option("--scope <scope>", "your home directory or the current repository")
    .choices(["user", "project"])
    .default("user");

export const skillsInstall: CommandSpec = {
  path: ["skills", "install"],
  summary: "Copy the bundled skills into agent skill directories",
  configure(command) {
    command
      .addOption(agentOption())
      .addOption(scopeOption())
      .option("--force", "overwrite skills you have edited", false);
  },
  async run(ctx, { options }) {
    const rows = await installSkills(
      ctx,
      { agent: options["agent"] as Agent | "all", scope: options["scope"] as Scope },
      { force: options["force"] === true, version: CLI_VERSION },
    );
    return { data: rows };
  },
};
