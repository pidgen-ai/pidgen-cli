import {
  AGENT_KINDS,
  agentLoginCommand,
  agentNotFound,
  agentStatus,
  agentStatusCommand,
  codingAgent,
  findAgent,
  runAgentLogin,
  type AgentKind,
} from "../../core/agents.js";
import { CliError, usageError } from "../../core/errors.js";
import { ExitCode } from "../../core/exit-codes.js";
import type { CommandSpec } from "../../core/registry.js";

/**
 * `pidgen worker login claude|codex`: signs this machine's coding agent in to its default home,
 * which the worker reads. It runs the agent's own login with the terminal inherited
 * (`claude auth login`; `codex login --device-auth`), then its status command (`claude auth
 * status`; `codex login status`). `data` is `{harness, login}`: `login` is `ready`, or `unknown`
 * when the agent has no status command to ask; `not_ready` exits 3 with `AGENT_NOT_SIGNED_IN` and
 * a fix. An agent not on `PATH` exits 2 with `AGENT_NOT_FOUND` and its `npm install -g` command.
 */
export const workerLogin: CommandSpec = {
  path: ["worker", "login"],
  summary: "Sign a coding agent (claude or codex) in on this machine",
  configure(command) {
    command.argument("<agent>", `the coding agent: ${AGENT_KINDS.join(" or ")}`);
  },
  async run(ctx, { args }) {
    const kind = args[0];
    if (kind === undefined || !(AGENT_KINDS as readonly string[]).includes(kind)) {
      throw usageError(
        `pidgen worker login signs in to ${AGENT_KINDS.join(" or ")}, not ${kind ?? "nothing"}.`,
      );
    }
    const agent = codingAgent(kind as AgentKind);
    const runtime = ctx.workerRuntime;
    const executable = await findAgent(ctx, agent, runtime);
    if (executable === null) throw agentNotFound(agent);

    ctx.io.stderr(`$ ${agentLoginCommand(agent)}\n`);
    await runAgentLogin(ctx, executable, agent, runtime);
    const login = await agentStatus(ctx, executable, agent, runtime);
    if (login === "not_ready") {
      const fix = `Run \`${agentLoginCommand(agent)}\` and finish signing in, then check with \`${agentStatusCommand(agent)}\`.`;
      throw new CliError(
        "AGENT_NOT_SIGNED_IN",
        `${agent.name} is not signed in: \`${agentStatusCommand(agent)}\` says so. Run \`pidgen worker login ${agent.kind}\` again and finish signing in.`,
        ExitCode.Auth,
        { harness: agent.kind, login, fix },
      );
    }
    return { data: { harness: agent.kind, login } };
  },
};
