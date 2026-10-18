import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fakes for the coding agents setup installs and signs in to, and for the `npm` that installs
 * them. Each fake logs its argument list (and whether `CLAUDE_CONFIG_DIR` or `CODEX_HOME` reached
 * it) to `FAKE_AGENT_LOG`. Signing in writes `<kind>.signed-in` under `FAKE_AGENT_STATE`; the
 * status command exits 0 when that file is there and 1 when it is not.
 */

export type FakeAgentKind = "claude" | "codex";

export interface FakeAgentOptions {
  /** The status command is not one this release knows (an older release). */
  noStatus?: boolean;
  /** The login command exits 1 and signs nothing in. */
  loginFails?: boolean;
}

export interface AgentRun {
  command: string;
  args: string[];
  env: { CLAUDE_CONFIG_DIR: string | null; CODEX_HOME: string | null };
}

/** The script of a fake `claude` or `codex`. */
export function fakeAgent(kind: FakeAgentKind, options: FakeAgentOptions = {}): string {
  const [login, status] =
    kind === "claude"
      ? [JSON.stringify(["auth", "login"]), JSON.stringify(["auth", "status"])]
      : [JSON.stringify(["login", "--device-auth"]), JSON.stringify(["login", "status"])];
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({
  command: ${JSON.stringify(kind)},
  args,
  env: {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
  },
}) + "\\n");
const marker = path.join(process.env.FAKE_AGENT_STATE, ${JSON.stringify(`${kind}.signed-in`)});
const is = (expected) => JSON.stringify(args) === JSON.stringify(expected);
if (is(${login})) {
  if (${options.loginFails === true}) { process.stderr.write("login failed\\n"); process.exit(1); }
  fs.mkdirSync(process.env.FAKE_AGENT_STATE, { recursive: true });
  fs.writeFileSync(marker, "yes");
  process.exit(0);
}
if (is(${status})) {
  if (${options.noStatus === true}) {
    process.stderr.write(${JSON.stringify(kind === "claude" ? "error: unknown command 'auth'" : "error: unrecognized subcommand 'status'")} + "\\n");
    process.exit(2);
  }
  if (fs.existsSync(marker)) { process.stdout.write("Logged in\\n"); process.exit(0); }
  process.stdout.write("Not logged in\\n");
  process.exit(1);
}
process.exit(0);
`;
}

/**
 * A fake `npm`: `npm install -g <package>` logs its arguments and puts the fake agent the package
 * holds into `FAKE_NPM_BIN`. With `FAKE_NPM_EACCES` set it fails as npm does when it may not write
 * its global directory.
 */
export function fakeNpm(): string {
  const packages = {
    "@anthropic-ai/claude-code": { command: "claude", script: fakeAgent("claude") },
    "@openai/codex": { command: "codex", script: fakeAgent("codex") },
  };
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ command: "npm", args, env: {} }) + "\\n");
const packages = ${JSON.stringify(packages)};
if (args[0] === "install" && args[1] === "-g" && packages[args[2]]) {
  if (process.env.FAKE_NPM_EACCES) {
    process.stderr.write("npm error code EACCES\\nnpm error syscall mkdir\\nnpm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/x'\\n");
    process.exit(243);
  }
  if (process.env.FAKE_NPM_FAIL) { process.stderr.write("npm error code E404\\n"); process.exit(1); }
  const entry = packages[args[2]];
  fs.mkdirSync(process.env.FAKE_NPM_BIN, { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_NPM_BIN, entry.command), entry.script, { mode: 0o755 });
  process.stdout.write("added 3 packages in 2s\\n");
  process.exit(0);
}
process.exit(1);
`;
}

export async function writeExecutable(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/** Where the fakes log and keep their state, as environment variables, and how to read the log. */
export function agentFiles(directory: string): {
  env: Record<string, string>;
  state: string;
  runs: () => Promise<AgentRun[]>;
} {
  const log = join(directory, "agents.log");
  const state = join(directory, "agent-state");
  return {
    env: { FAKE_AGENT_LOG: log, FAKE_AGENT_STATE: state },
    state,
    runs: async () => {
      try {
        return (await readFile(log, "utf8"))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as AgentRun);
      } catch {
        return [];
      }
    },
  };
}

/** Marks a fake agent signed in, as its login would. */
export async function signIn(state: string, kind: FakeAgentKind): Promise<void> {
  await mkdir(state, { recursive: true });
  await writeFile(join(state, `${kind}.signed-in`), "yes");
}
