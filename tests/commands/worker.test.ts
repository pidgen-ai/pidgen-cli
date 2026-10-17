import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import {
  defaultWorkerRuntime,
  resolvePidgenHome,
  resolveWorker,
  type WorkerRuntime,
} from "../../src/core/worker.js";
import { envelope, tempDir, testContext } from "../support/context.js";

describe("worker commands", () => {
  it("reports when pidgen-worker is not found", async () => {
    const ctx = await testContext({ env: { PATH: "" } });

    expect(await runCli(["worker", "start"], ctx)).toBe(ExitCode.Usage);
    expect(envelope(ctx)).toMatchObject({
      ok: false,
      error: { code: "WORKER_NOT_FOUND" },
    });
  });

  it("passes the exit code from a foreground start", async () => {
    const { ctx } = await workerContext();

    expect(await runCli(["worker", "start", "--", "--exit", "23"], ctx)).toBe(23);
  });

  it("prints no envelope for a foreground start", async () => {
    const { ctx } = await workerContext();

    expect(await runCli(["worker", "start", "--", "--exit", "0"], ctx)).toBe(0);
    expect(ctx.out).toEqual([]);
  });

  // AC-13099f01c6dd: presentation cannot intercept the foreground worker's streams or status.
  it.each([undefined, "json", "table"])(
    "foreground %s inherits all streams and returns worker status",
    async (format) => {
      const spawns: unknown[] = [];
      const runtime: WorkerRuntime = {
        ...defaultWorkerRuntime,
        spawn(command, args, options) {
          spawns.push(options.stdio);
          return defaultWorkerRuntime.spawn(command, args, options);
        },
      };
      const { ctx } = await workerContext(runtime);
      ctx.io.stdoutIsTTY = true;
      const flags = format ? ["--format", format] : [];
      expect(await runCli([...flags, "worker", "start", "--", "--exit", "23"], ctx)).toBe(23);
      expect(spawns).toEqual(["inherit"]);
      expect(ctx.out).toEqual([]);
      expect(ctx.err).toEqual([]);
    },
  );

  it("resolves the worker from PIDGEN_WORKER_BIN", async () => {
    const { ctx, directory } = await workerContext();
    ctx.env = { PIDGEN_WORKER_BIN: join(directory, "pidgen-worker"), PATH: "" };

    expect(await runCli(["worker", "start", "--", "--exit", "17"], ctx)).toBe(17);
  });

  it("forwards SIGTERM to the worker", async () => {
    const directory = await tempDir("pidgen-worker-signal-");
    const readyFile = join(directory, "ready");
    const signalFile = join(directory, "signal");
    const listeners = new Map<string, () => void>();
    const runtime: WorkerRuntime = {
      ...defaultWorkerRuntime,
      onSignal: (signal, listener) => listeners.set(signal, listener),
      offSignal: (signal) => listeners.delete(signal),
    };
    const { ctx } = await workerContext(runtime, directory);

    const running = runCli(
      ["worker", "start", "--", "--wait-for-signal", readyFile, signalFile],
      ctx,
    );
    await waitForFile(readyFile);
    listeners.get("SIGTERM")?.();

    expect(await running).toBe(0);
    expect(await readFile(signalFile, "utf8")).toBe("SIGTERM");
    expect(listeners.size).toBe(0);
  });

  it("maps a terminating signal to 128 plus its signal number", async () => {
    const directory = await tempDir("pidgen-worker-termination-");
    const readyFile = join(directory, "ready");
    const listeners = new Map<string, () => void>();
    const runtime: WorkerRuntime = {
      ...defaultWorkerRuntime,
      onSignal: (signal, listener) => listeners.set(signal, listener),
      offSignal: (signal) => listeners.delete(signal),
    };
    const { ctx } = await workerContext(runtime, directory);

    const running = runCli(["worker", "start", "--", "--wait", readyFile], ctx);
    await waitForFile(readyFile);
    listeners.get("SIGTERM")?.();

    expect(await running).toBe(143);
  });

  it("returns the worker doctor report as data", async () => {
    const { ctx, directory } = await workerContext();

    expect(await runCli(["worker", "doctor", "--", "--extra-check"], ctx)).toBe(0);
    expect(envelope(ctx)).toMatchObject({
      ok: true,
      data: {
        healthy: true,
        args: ["--extra-check"],
        pidgen_home: join(directory, ".pidgen"),
      },
    });
  });

  it("reports a worker doctor failure", async () => {
    const report = { healthy: false, checks: [{ name: "runtime", ok: false }] };
    const { ctx } = await workerContext();

    expect(await runCli(["worker", "doctor", "--", "--fail"], ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(ctx)).toMatchObject({
      ok: false,
      error: { code: "DOCTOR_FAILED", details: report },
    });
  });

  it("refuses an unsupported platform", async () => {
    const directory = await tempDir();
    const runtime = { ...defaultWorkerRuntime, platform: "win32" as const };

    await expect(
      resolveWorker({ env: {}, homeDir: directory, cwd: directory }, runtime),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM", exitCode: ExitCode.Usage });
  });

  it("resolves PIDGEN_HOME from the environment or home directory", () => {
    expect(
      resolvePidgenHome({ env: { PIDGEN_HOME: "/custom/pidgen" }, homeDir: "/home/test" }),
    ).toBe("/custom/pidgen");
    expect(resolvePidgenHome({ env: {}, homeDir: "/home/test" })).toBe("/home/test/.pidgen");
  });
});

async function workerContext(
  workerRuntime: WorkerRuntime = defaultWorkerRuntime,
  directory?: string,
) {
  const workerDirectory = directory ?? (await tempDir("pidgen-worker-test-"));
  const worker = join(workerDirectory, "pidgen-worker");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "doctor") {
  const doctorArgs = args.slice(2);
  const failing = doctorArgs.includes("--fail");
  const report = failing
    ? { healthy: false, checks: [{ name: "runtime", ok: false }] }
    : { healthy: true, args: doctorArgs, pidgen_home: process.env.PIDGEN_HOME };
  process.stdout.write(JSON.stringify(report));
  process.exit(failing ? 1 : 0);
}
if (args[0] === "--wait-for-signal") {
  fs.writeFileSync(args[1], "ready");
  process.on("SIGTERM", () => {
    fs.writeFileSync(args[2], "SIGTERM");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else if (args[0] === "--wait") {
  fs.writeFileSync(args[1], "ready");
  setInterval(() => {}, 1000);
} else {
  const exitIndex = args.indexOf("--exit");
  process.exit(exitIndex === -1 ? 0 : Number(args[exitIndex + 1]));
}
`;
  await writeFile(worker, script);
  await chmod(worker, 0o755);
  const ctx = await testContext({
    cwd: workerDirectory,
    homeDir: workerDirectory,
    env: { PATH: [workerDirectory, process.env["PATH"] ?? ""].join(delimiter) },
    workerRuntime,
  });
  return { ctx, directory: workerDirectory };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
