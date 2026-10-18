import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { envelope } from "../support/context.js";
import { installContext } from "../support/worker-install.js";
import {
  agentFiles,
  fakeAgent,
  signIn,
  writeExecutable,
  type FakeAgentKind,
  type FakeAgentOptions,
} from "../support/agents.js";

/**
 * `pidgen worker login claude|codex` against fake agents on PATH: the login runs with the terminal
 * inherited, then the status command decides `ready`, `not_ready` or `unknown`.
 */

interface Body {
  ok: boolean;
  data: { harness: string; login: string } | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
}

async function setupLogin(
  kind: FakeAgentKind | null,
  options: FakeAgentOptions & { env?: Record<string, string> } = {},
) {
  const base = await installContext({ commands: [] });
  const files = agentFiles(base.directory);
  Object.assign(base.ctx.env, files.env, options.env ?? {});
  if (kind !== null) await writeExecutable(join(base.pathDir, kind), fakeAgent(kind, options));
  return {
    ...base,
    ...files,
    async run(...argv: string[]) {
      base.ctx.out.length = 0;
      base.ctx.err.length = 0;
      const code = await runCli(["--format", "json", ...argv], base.ctx);
      return { code, body: envelope(base.ctx) as unknown as Body };
    },
  };
}

describe("pidgen worker login", () => {
  // c2-login-command: claude's login, then its status, with the terminal inherited.
  it("runs `claude auth login` with the terminal, then `claude auth status`, and reports ready", async () => {
    const h = await setupLogin("claude");

    const { code, body } = await h.run("worker", "login", "claude");

    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ harness: "claude", login: "ready" });
    expect((await h.runs()).map((run) => run.args)).toEqual([
      ["auth", "login"],
      ["auth", "status"],
    ]);
    const login = h.spawns.find((spawn) => spawn.args.join(" ") === "auth login")!;
    expect(login.command).toBe(join(h.pathDir, "claude"));
    expect(login.options.stdio).toBe("inherit");
    expect(login.options.shell).toBeFalsy();
  });

  it("runs `codex login --device-auth`, then `codex login status`", async () => {
    const h = await setupLogin("codex");

    const { code, body } = await h.run("worker", "login", "codex");

    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ harness: "codex", login: "ready" });
    expect((await h.runs()).map((run) => run.args)).toEqual([
      ["login", "--device-auth"],
      ["login", "status"],
    ]);
    const login = h.spawns.find((spawn) => spawn.args.join(" ") === "login --device-auth")!;
    expect(login.options.stdio).toBe("inherit");
  });

  it("signs in to the agent's default home: CLAUDE_CONFIG_DIR and CODEX_HOME do not reach it", async () => {
    const h = await setupLogin("claude", {
      env: { CLAUDE_CONFIG_DIR: "/elsewhere/claude", CODEX_HOME: "/elsewhere/codex" },
    });

    const { code } = await h.run("worker", "login", "claude");

    expect(code).toBe(ExitCode.Ok);
    for (const run of await h.runs()) {
      expect(run.env).toEqual({ CLAUDE_CONFIG_DIR: null, CODEX_HOME: null });
    }
  });

  it("not_ready after the login exits non-zero with AGENT_NOT_SIGNED_IN and a fix", async () => {
    const h = await setupLogin("codex", { loginFails: true });

    const { code, body } = await h.run("worker", "login", "codex");

    expect(code).not.toBe(ExitCode.Ok);
    expect(code).toBe(ExitCode.Auth);
    expect(body.error).toMatchObject({
      code: "AGENT_NOT_SIGNED_IN",
      details: {
        harness: "codex",
        login: "not_ready",
        fix: expect.stringContaining("codex login"),
      },
    });
    expect(body.error!.message).toContain("pidgen worker login codex");
    // The status command still ran after the failed login.
    expect((await h.runs()).map((run) => run.args)).toEqual([
      ["login", "--device-auth"],
      ["login", "status"],
    ]);
  });

  it("reports unknown when the agent has no status command", async () => {
    const h = await setupLogin("claude", { noStatus: true });

    const { code, body } = await h.run("worker", "login", "claude");

    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toEqual({ harness: "claude", login: "unknown" });
  });

  it("runs the login even when the agent is signed in already", async () => {
    const h = await setupLogin("claude");
    await signIn(h.state, "claude");

    const { body } = await h.run("worker", "login", "claude");

    expect(body.data).toEqual({ harness: "claude", login: "ready" });
    expect((await h.runs()).map((run) => run.args[1])).toEqual(["login", "status"]);
  });

  it("an agent that is not on PATH fails with AGENT_NOT_FOUND and its npm install command", async () => {
    const h = await setupLogin(null);

    const { code, body } = await h.run("worker", "login", "claude");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({
      code: "AGENT_NOT_FOUND",
      details: {
        harness: "claude",
        fix: expect.stringContaining("npm install -g @anthropic-ai/claude-code"),
      },
    });
  });

  it("refuses an agent it cannot sign in to", async () => {
    for (const agent of ["pi", "gemini"]) {
      const h = await setupLogin(null);
      const { code, body } = await h.run("worker", "login", agent);
      expect(code, agent).toBe(ExitCode.Usage);
      expect(body.error!.code).toBe("CLI_USAGE");
      expect(await h.runs()).toEqual([]);
    }
  });
});
