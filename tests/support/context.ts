import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunContext } from "../../src/core/context.js";
import { defaultWorkerRuntime } from "../../src/core/worker.js";

export const REPO_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

export interface TestContext extends RunContext {
  out: string[];
  err: string[];
}

export async function tempDir(prefix = "pidgen-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function testContext(overrides: Partial<RunContext> = {}): Promise<TestContext> {
  const out: string[] = [];
  const err: string[] = [];
  const home = overrides.homeDir ?? (await tempDir());
  let clock = 0;
  return {
    env: {},
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      interactive: false,
      stdoutIsTTY: false,
    },
    fetch: () => Promise.reject(new Error("unexpected network call")),
    homeDir: home,
    cwd: home,
    bundledSkillsDir: REPO_SKILLS_DIR,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    readStdin: () => Promise.reject(new Error("unexpected read of standard input")),
    workerRuntime: defaultWorkerRuntime,
    provenanceTrust: () => ({
      identities: [],
      trustedRoot: () => Promise.reject(new Error("unexpected load of a Sigstore trust root")),
    }),
    docker: {
      run: () => Promise.reject(new Error("unexpected docker call")),
      foreground: () => Promise.reject(new Error("unexpected docker call")),
    },
    cosign: { run: () => Promise.reject(new Error("unexpected cosign call")) },
    ask: null,
    hostName: "worker-host.example.com",
    ...overrides,
    out,
    err,
  };
}

/** The single JSON envelope a command printed. */
export function envelope(ctx: TestContext): Record<string, unknown> {
  const printed = ctx.out.join("");
  return JSON.parse(printed) as Record<string, unknown>;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** AC-2e82c79f28be: paired executions use the same fixtures, argv, requests and progress streams. */
export async function expectMutationParity<T>(
  ctx: TestContext,
  calls: T[],
  argv: string[],
  fragments: string[],
  exitCode = 0,
  normalize: (call: T) => unknown = (call) => call,
): Promise<Record<string, unknown>> {
  const { expect } = await import("vitest");
  const { runCli } = await import("../../src/cli.js");
  ctx.io.stdoutIsTTY = true;
  ctx.io.interactive = true;
  ctx.ask = () => {
    throw new Error("Mutation presentation must never prompt");
  };
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli([...argv, "--format", "json"], ctx)).toBe(exitCode);
  expect(ctx.out).toHaveLength(1);
  const json = envelope(ctx);
  const previousCalls = await Promise.all(calls.map(normalize));
  const previousErrors = [...ctx.err];
  calls.length = 0;
  ctx.out.length = 0;
  ctx.err.length = 0;
  expect(await runCli(argv, ctx)).toBe(exitCode);
  expect(ctx.out).toHaveLength(1);
  for (const fragment of fragments) expect(ctx.out[0]).toContain(fragment);
  expect(await Promise.all(calls.map(normalize))).toEqual(previousCalls);
  expect(ctx.err).toEqual(previousErrors);
  return json;
}
