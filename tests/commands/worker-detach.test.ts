import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import {
  defaultWorkerRuntime,
  type WorkerRecord,
  type WorkerRuntime,
} from "../../src/core/worker.js";
import { envelope, tempDir, testContext, type TestContext } from "../support/context.js";

describe("detached worker commands", () => {
  let harness: Awaited<ReturnType<typeof managerContext>>;

  beforeEach(async () => {
    harness = await managerContext();
  });

  it("records the worker and appends its output to worker-manager.log", async () => {
    await mkdir(join(harness.directory, ".pidgen", "logs"), { recursive: true });
    await writeFile(harness.logPath, "existing line\n");

    expect(
      await runCli(["worker", "start", "--detach", "--", "--label", "alpha"], harness.ctx),
    ).toBe(ExitCode.Ok);

    const result = envelope(harness.ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        running: true,
        record: {
          pid: 101,
          started_at: "2026-01-02T03:04:05.000Z",
          log: harness.logPath,
          command: [harness.worker, "--label", "alpha"],
        },
      },
    });
    expect(JSON.parse(await readFile(harness.recordPath, "utf8"))).toEqual(
      (result["data"] as { record: WorkerRecord }).record,
    );
    expect(await readFile(harness.logPath, "utf8")).toBe("existing line\nworker output\n");
    expect(harness.spawns[0]?.options).toMatchObject({
      cwd: harness.directory,
      detached: true,
    });
    expect(harness.spawns[0]?.options.stdio?.[0]).toBe("ignore");
    expect(harness.spawns[0]?.options.stdio?.[1]).toBe(harness.spawns[0]?.options.stdio?.[2]);
    expect(harness.spawns[0]?.options.env?.["PIDGEN_HOME"]).toBe(
      join(harness.directory, ".pidgen"),
    );
    expect(harness.unrefPids).toEqual([101]);
    expect(harness.sleeps).toContain(2_000);
  });

  it("refuses a second detach when the recorded worker is already running", async () => {
    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    harness.ctx.out.length = 0;

    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Refused);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: false,
      error: { code: "WORKER_ALREADY_RUNNING", details: { record: { pid: 101 } } },
    });
    expect(harness.spawns).toHaveLength(1);
  });

  it("replaces a stale worker record", async () => {
    await writeRecord(harness.recordPath, {
      pid: 77,
      started_at: "2025-01-01T00:00:00.000Z",
      log: harness.logPath,
      command: [harness.worker],
    });
    harness.processes.delete(77);

    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    expect(JSON.parse(await readFile(harness.recordPath, "utf8"))).toMatchObject({ pid: 101 });
  });

  it("replaces a stale record when its pid belongs to something other than pidgen-worker", async () => {
    await writeRecord(harness.recordPath, {
      pid: 78,
      started_at: "2025-01-01T00:00:00.000Z",
      log: harness.logPath,
      command: [harness.worker],
    });
    harness.processes.set(78, "/usr/bin/unrelated-process");

    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    expect(harness.spawns).toHaveLength(1);
  });

  it("reports WORKER_EXITED and the last 20 log lines when the worker exits early", async () => {
    harness.exitEarly = true;
    harness.output =
      Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: false,
      error: {
        code: "WORKER_EXITED",
        details: {
          record: { pid: 101, log: harness.logPath },
          log_tail: Array.from({ length: 20 }, (_, index) => `line ${index + 6}`),
        },
      },
    });
    await expect(access(harness.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses PIDGEN_WORKER_LOG_DIR for the manager log", async () => {
    const customLogDirectory = join(harness.directory, "worker-logs");
    harness.ctx.env["PIDGEN_WORKER_LOG_DIR"] = customLogDirectory;

    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: true,
      data: { record: { log: join(customLogDirectory, "worker-manager.log") } },
    });
    expect(await readFile(join(customLogDirectory, "worker-manager.log"), "utf8")).toBe(
      "worker output\n",
    );
  });

  it("worker stop terminates the worker and removes the record", async () => {
    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    harness.ctx.out.length = 0;

    expect(await runCli(["worker", "stop"], harness.ctx)).toBe(ExitCode.Ok);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: true,
      data: { forced: false, record: { pid: 101 } },
    });
    expect(harness.signals).toEqual([{ pid: 101, signal: "SIGTERM" }]);
    await expect(access(harness.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("worker stop reports WORKER_NOT_RUNNING when no managed worker runs", async () => {
    expect(await runCli(["worker", "stop"], harness.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: false,
      error: { code: "WORKER_NOT_RUNNING" },
    });
  });

  it("worker stop times out unless force kills the worker", async () => {
    harness.ignoreTerm = true;
    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    harness.ctx.out.length = 0;

    expect(await runCli(["worker", "stop", "--timeout", "1"], harness.ctx)).toBe(ExitCode.Network);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", details: { timeout_seconds: 1 } },
    });
    await expect(access(harness.recordPath)).resolves.toBeUndefined();

    harness.ctx.out.length = 0;
    expect(await runCli(["worker", "stop", "--timeout", "1", "--force"], harness.ctx)).toBe(
      ExitCode.Ok,
    );
    expect(envelope(harness.ctx)).toMatchObject({
      ok: true,
      data: { forced: true, record: { pid: 101 } },
    });
    expect(harness.signals.at(-1)).toEqual({ pid: 101, signal: "SIGKILL" });
    await expect(access(harness.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("worker status reports the record and whether the worker is running", async () => {
    expect(await runCli(["worker", "status"], harness.ctx)).toBe(ExitCode.Ok);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: true,
      data: { record: null, running: false },
    });

    harness.ctx.out.length = 0;
    expect(await runCli(["worker", "start", "--detach"], harness.ctx)).toBe(ExitCode.Ok);
    harness.ctx.out.length = 0;
    expect(await runCli(["worker", "status"], harness.ctx)).toBe(ExitCode.Ok);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: true,
      data: { record: { pid: 101 }, running: true },
    });

    harness.processes.delete(101);
    harness.ctx.out.length = 0;
    expect(await runCli(["worker", "status"], harness.ctx)).toBe(ExitCode.Ok);
    expect(envelope(harness.ctx)).toMatchObject({
      ok: true,
      data: { record: { pid: 101 }, running: false },
    });
  });

  it("rejects invalid stop timeout usage", async () => {
    expect(await runCli(["worker", "stop", "--timeout", "0"], harness.ctx)).toBe(ExitCode.Usage);
    expect(envelope(harness.ctx)).toMatchObject({ ok: false, error: { code: "CLI_USAGE" } });
  });
});

async function managerContext() {
  const directory = await tempDir("pidgen-worker-manager-");
  const worker = join(directory, "pidgen-worker");
  await writeFile(worker, "worker");
  const recordPath = join(directory, ".pidgen", "run", "pidgen-worker.json");
  const logPath = join(directory, ".pidgen", "logs", "worker-manager.log");
  const processes = new Map<number, string>();
  const spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const unrefPids: number[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const sleeps: number[] = [];
  let clock = Date.parse("2026-01-02T03:04:05.000Z");

  const state = {
    ctx: undefined as unknown as TestContext,
    directory,
    worker,
    recordPath,
    logPath,
    processes,
    spawns,
    unrefPids,
    signals,
    sleeps,
    output: "worker output\n",
    exitEarly: false,
    ignoreTerm: false,
  };
  const runtime: WorkerRuntime = {
    ...defaultWorkerRuntime,
    canExecute: async () => undefined,
    spawn: (command, args, options) => {
      const pid = 101;
      spawns.push({ command, args, options });
      const stdout = Array.isArray(options.stdio) ? options.stdio[1] : undefined;
      if (typeof stdout === "number") writeSync(stdout, state.output);
      if (state.exitEarly) processes.delete(pid);
      else processes.set(pid, worker);
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, "pid", { value: pid });
      child.unref = () => {
        unrefPids.push(pid);
        return child;
      };
      return child;
    },
    isWorkerProcess: async (pid, executable) => processes.get(pid) === executable,
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL" || !state.ignoreTerm) processes.delete(pid);
    },
  };
  state.ctx = await testContext({
    cwd: directory,
    homeDir: directory,
    env: { PATH: [directory, process.env["PATH"] ?? ""].join(delimiter) },
    workerRuntime: runtime,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return state;
}

async function writeRecord(path: string, record: WorkerRecord): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(record));
}
