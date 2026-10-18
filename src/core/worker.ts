import { constants } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

export interface WorkerConfig {
  env: Record<string, string | undefined>;
  homeDir: string;
  cwd: string;
  /** Where a collected child's output goes (`pipeChildren`); the CLI's standard error otherwise. */
  io?: ChildOutputIo;
}

/**
 * A caller that collects the output of the commands it runs: with `pipeChildren` set, a child's
 * standard output and error are piped and written to `stderr()`, line by line, instead of going
 * to the CLI's standard error. `pidgen setup` sets it, to keep that output off the screen.
 */
export interface ChildOutputIo {
  stderr(text: string): void;
  pipeChildren?: boolean;
}

/** The text a secret is replaced with wherever the CLI shows or records a child's output. */
export const REDACTED = "[redacted]";

/** A line-buffered writer of a child's output to `io.stderr()`, with each secret replaced. */
export interface ChildOutputWriter {
  write(chunk: string | Buffer): void;
  /** Writes what is left of an unfinished last line. */
  end(): void;
}

/**
 * The writer of a collected child's output when `io` collects it (`pipeChildren`), else `null`:
 * the child then keeps the CLI's standard error. Each line is written whole, with every one of
 * `secrets` replaced by `[redacted]`.
 */
export function collectedOutput(
  io: ChildOutputIo | undefined,
  secrets: readonly string[] = [],
): ChildOutputWriter | null {
  if (io?.pipeChildren !== true) return null;
  const hide = (text: string) =>
    secrets.reduce(
      (shown, secret) => (secret === "" ? shown : shown.split(secret).join(REDACTED)),
      text,
    );
  let pending = "";
  return {
    write(chunk) {
      pending += chunk.toString();
      const end = pending.lastIndexOf("\n");
      if (end < 0) return;
      io.stderr(hide(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    },
    end() {
      if (pending !== "") io.stderr(hide(`${pending}\n`));
      pending = "";
    },
  };
}

export interface WorkerRuntime {
  platform: NodeJS.Platform;
  /** The processor architecture; `process.arch` when absent. Picks the worker wheel to install. */
  arch?: NodeJS.Architecture;
  canExecute(path: string): Promise<void>;
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  isWorkerProcess(pid: number, executable: string): Promise<boolean>;
  kill(pid: number, signal: NodeJS.Signals): void;
  onSignal(signal: ForwardedSignal, listener: () => void): void;
  offSignal(signal: ForwardedSignal, listener: () => void): void;
}

export interface WorkerRecord {
  pid: number;
  started_at: string;
  log: string;
  command: string[];
}

export interface WorkerManagerConfig extends WorkerConfig {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StopWorkerOptions {
  force: boolean;
  timeoutSeconds: number;
}

const STARTUP_WAIT_MS = 2_000;
const STOP_POLL_MS = 100;
const RECORD_NAME = "pidgen-worker.json";
const LOG_NAME = "worker-manager.log";

export const defaultWorkerRuntime: WorkerRuntime = {
  platform: process.platform,
  arch: process.arch,
  canExecute: (path) => access(path, fsConstants.X_OK),
  spawn: (command, args, options) => spawn(command, args, options),
  isWorkerProcess: defaultIsWorkerProcess,
  kill: (pid, signal) => process.kill(pid, signal),
  onSignal: (signal, listener) => process.on(signal, listener),
  offSignal: (signal, listener) => process.off(signal, listener),
};

export function resolvePidgenHome(config: Pick<WorkerConfig, "env" | "homeDir">): string {
  return config.env["PIDGEN_HOME"] || join(config.homeDir, ".pidgen");
}

/**
 * The `pidgen-worker` the CLI runs: `PIDGEN_WORKER_BIN` when it is set; else the executable the
 * install record names (`pidgen worker install` puts it in the worker home, which is not on
 * `PATH`); and only when there is no install record, the first `pidgen-worker` on `PATH`. A
 * recorded worker that is missing is `WORKER_NOT_FOUND`, never another one found on `PATH`.
 */
export async function resolveWorker(
  config: WorkerConfig,
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<string> {
  assertSupportedPlatform(runtime);

  const configured = config.env["PIDGEN_WORKER_BIN"];
  if (configured) {
    const candidate = isAbsolute(configured) ? configured : resolve(config.cwd, configured);
    if (await isExecutable(candidate, runtime)) return candidate;
    throw workerNotFound();
  }

  const recorded = await recordedWorker(config);
  if (recorded !== null) {
    if (await isExecutable(recorded, runtime)) return recorded;
    throw new CliError(
      "WORKER_NOT_FOUND",
      `The worker the install record names, ${recorded}, is missing. Run \`pidgen worker install --force\` to install it again.`,
      ExitCode.Usage,
      { location: recorded },
    );
  }

  const found = await findOnPath(config, "pidgen-worker", runtime);
  if (found !== null) return found;
  throw workerNotFound();
}

/** The install record's file name, in `<worker home>/run/`. */
export const INSTALL_RECORD_NAME = "pidgen-install.json";

export function installRecordPath(config: Pick<WorkerConfig, "env" | "homeDir">): string {
  return join(resolvePidgenHome(config), "run", INSTALL_RECORD_NAME);
}

export function installRecordInvalid(path: string): CliError {
  return new CliError(
    "INSTALL_RECORD_INVALID",
    `The worker install record at ${path} cannot be read. Run \`pidgen worker install --force\` to replace it.`,
    ExitCode.Unexpected,
    { path },
  );
}

/**
 * The `pidgen-worker` a wheel install record names, or `null` with no record (or a container
 * record, which runs no executable here). `worker-install.ts` validates the whole record; this
 * reads only what finding the executable needs.
 */
async function recordedWorker(
  config: Pick<WorkerConfig, "env" | "homeDir">,
): Promise<string | null> {
  const path = installRecordPath(config);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(text) as unknown;
  } catch {
    throw installRecordInvalid(path);
  }
  if (typeof record !== "object" || record === null) throw installRecordInvalid(path);
  const { form, location } = record as Record<string, unknown>;
  if (form === "container") return null;
  if (form !== "wheel" || typeof location !== "string" || location === "") {
    throw installRecordInvalid(path);
  }
  return location;
}

/** The file `pidgen-worker enroll` writes its credential to, in the worker home. */
export const WORKER_ENV_NAME = "worker.env";

/**
 * What the CLI may know of the worker home's `worker.env`: whether it holds a credential, never the
 * credential itself.
 */
export interface WorkerCredential {
  /** The file read: `$PIDGEN_HOME/worker.env`. */
  path: string;
  /** Whether `PIDGEN_NODE_TOKEN` is present and non-empty. */
  credential: boolean;
  /** `PIDGEN_SERVICE_URL`: the server the worker enrolled with, or `null`. */
  serviceUrl: string | null;
  /** `PIDGEN_LOCALITY_DOMAIN`: the worker's host id in the Account, or `null`. */
  hostId: string | null;
}

/**
 * Reads the worker home's `worker.env` for whether it holds a credential, and the server and host
 * id it was enrolled with. A missing file is a home with no credential. The credential's value is
 * never returned, kept, or printed.
 */
export async function readWorkerCredential(
  config: Pick<WorkerConfig, "env" | "homeDir">,
): Promise<WorkerCredential> {
  const path = join(resolvePidgenHome(config), WORKER_ENV_NAME);
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const equals = line.indexOf("=");
    if (line.startsWith("#") || equals <= 0) continue;
    let value = line.slice(equals + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values.set(line.slice(0, equals).trim(), value);
  }
  const named = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === "" ? null : value;
  };
  return {
    path,
    credential: named("PIDGEN_NODE_TOKEN") !== null,
    serviceUrl: named("PIDGEN_SERVICE_URL"),
    hostId: named("PIDGEN_LOCALITY_DOMAIN"),
  };
}

/** True when the worker runs on `runtime`'s platform: Linux and macOS. */
export function workerPlatformSupported(runtime: Pick<WorkerRuntime, "platform">): boolean {
  return runtime.platform === "linux" || runtime.platform === "darwin";
}

/** The first executable called `name` in a `PATH` directory, or `null` when there is none. */
export async function findOnPath(
  config: Pick<WorkerConfig, "env" | "cwd">,
  name: string,
  runtime: Pick<WorkerRuntime, "canExecute"> = defaultWorkerRuntime,
): Promise<string | null> {
  for (const directory of (config.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const base = isAbsolute(directory) ? directory : resolve(config.cwd, directory);
    const candidate = join(base, name);
    if (await isExecutable(candidate, runtime)) return candidate;
  }
  return null;
}

/** Like `resolveWorker`, but `null` when `pidgen-worker` is not installed. */
export async function findWorker(
  config: WorkerConfig,
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<string | null> {
  try {
    return await resolveWorker(config, runtime);
  } catch (error) {
    if (error instanceof CliError && error.code === "WORKER_NOT_FOUND") return null;
    throw error;
  }
}

/**
 * Runs `pidgen-worker enroll --token <token> --server <server> --no-start [args]`. The one-time
 * token goes only to the worker on its command line; the worker exchanges it for its credential at
 * `server`, the server the enrollment was created on, and stores that itself. `--no-start` leaves
 * starting to `pidgen worker start`, which records the worker it starts. `args` come last, so the
 * caller's own flags win. The worker's output goes to the CLI's standard error, or, when the caller
 * collects it (`io.pipeChildren`), to `io.stderr()` after the command's line, with the token
 * replaced by `[redacted]` in both. Returns the worker's exit status.
 */
export async function runWorkerEnroll(
  config: WorkerConfig,
  worker: string,
  token: string,
  server: string,
  args: readonly string[],
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<number> {
  const enroll = ["enroll", "--token", token, "--server", server, "--no-start", ...args];
  const collected = collectedOutput(config.io, [token]);
  if (collected !== null) {
    const shown = [worker, ...enroll].map((arg) => (arg === token ? REDACTED : arg));
    config.io!.stderr(`$ ${displayCommand(shown)}\n`);
  }
  const child = runtime.spawn(worker, enroll, {
    cwd: config.cwd,
    env: workerEnvironment(config),
    stdio: collected ? ["inherit", "pipe", "pipe"] : ["inherit", 2, 2],
  });
  child.stdout?.on("data", (chunk: string | Buffer) => collected?.write(chunk));
  child.stderr?.on("data", (chunk: string | Buffer) => collected?.write(chunk));
  const status = await waitForChild(child);
  collected?.end();
  return status;
}

export async function runWorkerForeground(
  config: WorkerConfig,
  args: readonly string[],
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<number> {
  const worker = await resolveWorker(config, runtime);
  return runForeground(config, worker, args, runtime, workerNotFound);
}

/**
 * Runs `command` in the foreground with inherited standard streams, forwarding `SIGINT` and
 * `SIGTERM` to it, and resolves with its exit status (or 128 plus the signal number). A command
 * that cannot be found rejects with `notFound()`.
 */
export function runForeground(
  config: WorkerConfig,
  command: string,
  args: readonly string[],
  runtime: WorkerRuntime,
  notFound: () => Error,
): Promise<number> {
  const child = runtime.spawn(command, args, {
    cwd: config.cwd,
    env: workerEnvironment(config),
    stdio: "inherit",
  });

  return new Promise((resolveExit, reject) => {
    let settled = false;
    const listeners = new Map<ForwardedSignal, () => void>();

    const cleanUp = () => {
      for (const [signal, listener] of listeners) runtime.offSignal(signal, listener);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanUp();
      action();
    };

    for (const signal of FORWARDED_SIGNALS) {
      const listener = () => child.kill(signal);
      listeners.set(signal, listener);
      runtime.onSignal(signal, listener);
    }

    child.once("error", (error) =>
      settle(() => reject(isNotFoundError(error) ? notFound() : error)),
    );
    child.once("close", (code, signal) =>
      settle(() => resolveExit(code ?? exitCodeForSignal(signal))),
    );
  });
}

export async function runWorkerDoctor(
  config: WorkerConfig,
  args: readonly string[],
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<Record<string, unknown>> {
  const worker = await resolveWorker(config, runtime);
  const argv = ["doctor", "--json", ...args];
  const collected = collectedOutput(config.io);
  if (collected !== null) config.io!.stderr(`$ ${displayCommand([worker, ...argv])}\n`);
  const child = runtime.spawn(worker, argv, {
    cwd: config.cwd,
    env: workerEnvironment(config),
    stdio: ["inherit", "pipe", collected ? "pipe" : "inherit"],
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: string | Buffer) => collected?.write(chunk));
  const exitCode = await waitForChild(child);
  collected?.end();
  const output = Buffer.concat(chunks).toString("utf8");
  // The report is the output a person reads: collected, it is kept as the worker printed it.
  collected?.write(output);
  collected?.end();

  if (exitCode !== ExitCode.Ok) {
    const report = tryParseDoctorReport(output);
    throw new CliError(
      "DOCTOR_FAILED",
      "The worker doctor reported a failing check.",
      ExitCode.Unexpected,
      report ?? { output },
    );
  }
  return parseDoctorReport(output);
}

/**
 * Runs `pidgen-worker capacity <args>` with its standard output and error captured together, and
 * resolves with its exit status and that output. The worker validates and writes its `node.yaml`
 * and asks a running manager to apply it.
 */
export async function runWorkerCapacity(
  config: WorkerConfig,
  args: readonly string[],
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<{ status: number; output: string }> {
  const worker = await resolveWorker(config, runtime);
  const child = runtime.spawn(worker, ["capacity", ...args], {
    cwd: config.cwd,
    env: workerEnvironment(config),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)));
  const status = await waitForChild(child);
  return { status, output: Buffer.concat(chunks).toString("utf8") };
}

export async function startWorkerDetached(
  config: WorkerManagerConfig,
  args: readonly string[],
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<WorkerRecord> {
  assertSupportedPlatform(runtime);
  const current = await readWorkerRecord(config);
  if (current && (await recordIsRunning(current, runtime))) {
    throw new CliError(
      "WORKER_ALREADY_RUNNING",
      `pidgen-worker is already running with pid ${current.pid}.`,
      ExitCode.Refused,
      { record: current },
    );
  }
  if (current) await removeWorkerRecord(config);
  const worker = await resolveWorker(config, runtime);

  const pidgenHome = resolvePidgenHome(config);
  const logDirectory = config.env["PIDGEN_WORKER_LOG_DIR"] || join(pidgenHome, "logs");
  const logPath = join(logDirectory, LOG_NAME);
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(pidgenHome, "run"), { recursive: true, mode: 0o700 });

  const log = await open(logPath, "a", 0o600);
  let child: ChildProcess;
  let pid: number;
  try {
    child = runtime.spawn(worker, args, {
      cwd: config.cwd,
      env: workerEnvironment(config),
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    pid = await spawnedPid(child);
    child.unref();
  } finally {
    await log.close();
  }

  const record: WorkerRecord = {
    pid,
    started_at: new Date(config.now()).toISOString(),
    log: logPath,
    command: [worker, ...args],
  };
  await writeWorkerRecord(config, record);
  await config.sleep(STARTUP_WAIT_MS);

  if (!(await recordIsRunning(record, runtime))) {
    await removeWorkerRecord(config);
    throw new CliError(
      "WORKER_EXITED",
      "pidgen-worker exited during startup.",
      ExitCode.Unexpected,
      {
        record,
        log_tail: await readLogTail(logPath),
      },
    );
  }
  return record;
}

export async function stopWorker(
  config: WorkerManagerConfig,
  options: StopWorkerOptions,
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<{ record: WorkerRecord; forced: boolean }> {
  assertSupportedPlatform(runtime);
  const record = await readWorkerRecord(config);
  if (!record || !(await recordIsRunning(record, runtime))) {
    if (record) await removeWorkerRecord(config);
    throw new CliError(
      "WORKER_NOT_RUNNING",
      "No managed pidgen-worker process is running.",
      ExitCode.NotFound,
      record ? { record } : {},
    );
  }

  signalWorker(record.pid, "SIGTERM", runtime);
  const deadline = config.now() + options.timeoutSeconds * 1_000;
  while (await recordIsRunning(record, runtime)) {
    const remaining = deadline - config.now();
    if (remaining <= 0) break;
    await config.sleep(Math.min(STOP_POLL_MS, remaining));
  }

  if (!(await recordIsRunning(record, runtime))) {
    await removeWorkerRecord(config);
    return { record, forced: false };
  }
  if (!options.force) {
    throw new CliError(
      "TIMEOUT",
      `pidgen-worker did not stop within ${options.timeoutSeconds} seconds.`,
      ExitCode.Network,
      { record, timeout_seconds: options.timeoutSeconds },
    );
  }

  signalWorker(record.pid, "SIGKILL", runtime);
  await removeWorkerRecord(config);
  return { record, forced: true };
}

export async function workerStatus(
  config: WorkerConfig,
  runtime: WorkerRuntime = defaultWorkerRuntime,
): Promise<{ record: WorkerRecord | null; running: boolean }> {
  assertSupportedPlatform(runtime);
  const record = await readWorkerRecord(config);
  return { record, running: record ? await recordIsRunning(record, runtime) : false };
}

/**
 * The worker's environment: the CLI's own, with `PIDGEN_HOME` set and without `PIDGEN_TOKEN`, since the
 * worker never receives a person's credential.
 */
export function workerEnvironment(
  config: Pick<WorkerConfig, "env" | "homeDir">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...config.env, PIDGEN_HOME: resolvePidgenHome(config) };
  delete env["PIDGEN_TOKEN"];
  return env;
}

export function assertSupportedPlatform(runtime: Pick<WorkerRuntime, "platform">): void {
  if (!workerPlatformSupported(runtime)) {
    throw new CliError(
      "UNSUPPORTED_PLATFORM",
      `pidgen-worker is not supported on ${runtime.platform}.`,
      ExitCode.Usage,
      { platform: runtime.platform },
    );
  }
}

function workerRecordPath(config: Pick<WorkerConfig, "env" | "homeDir">): string {
  return join(resolvePidgenHome(config), "run", RECORD_NAME);
}

async function readWorkerRecord(config: WorkerConfig): Promise<WorkerRecord | null> {
  let text: string;
  try {
    text = await readFile(workerRecordPath(config), "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return isWorkerRecord(value) ? value : null;
}

async function writeWorkerRecord(config: WorkerConfig, record: WorkerRecord): Promise<void> {
  await writeFile(workerRecordPath(config), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function removeWorkerRecord(config: WorkerConfig): Promise<void> {
  await rm(workerRecordPath(config), { force: true });
}

function isWorkerRecord(value: unknown): value is WorkerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(candidate["pid"]) &&
    (candidate["pid"] as number) > 0 &&
    typeof candidate["started_at"] === "string" &&
    typeof candidate["log"] === "string" &&
    Array.isArray(candidate["command"]) &&
    candidate["command"].length > 0 &&
    candidate["command"].every((part) => typeof part === "string")
  );
}

async function recordIsRunning(record: WorkerRecord, runtime: WorkerRuntime): Promise<boolean> {
  return runtime.isWorkerProcess(record.pid, record.command[0]!);
}

async function spawnedPid(child: ChildProcess): Promise<number> {
  if (child.pid !== undefined) return child.pid;
  return new Promise((resolvePid, reject) => {
    child.once("spawn", () => {
      if (child.pid === undefined) reject(new Error("pidgen-worker started without a process id."));
      else resolvePid(child.pid);
    });
    child.once("error", (error) => reject(isNotFoundError(error) ? workerNotFound() : error));
  });
}

/** The last 20 lines of a log's text. */
export function logTail(contents: string): string[] {
  if (contents.length === 0) return [];
  return contents
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .slice(-20);
}

/** A shell-safe rendering of a command, for display only: `$ <this>` is printed before it runs. */
export function displayCommand(argv: readonly string[]): string {
  return argv
    .map((argument) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

async function readLogTail(path: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
  return logTail(contents);
}

function signalWorker(pid: number, signal: NodeJS.Signals, runtime: WorkerRuntime): void {
  try {
    runtime.kill(pid, signal);
  } catch (error) {
    if (!isProcessNotFoundError(error)) throw error;
  }
}

async function defaultIsWorkerProcess(pid: number, executable: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isProcessNotFoundError(error)) return false;
    throw error;
  }

  if (process.platform === "linux") {
    try {
      const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return commandLine.split("\0").includes(executable);
    } catch (error) {
      if (isFileNotFoundError(error)) return false;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    const commandLine = await psCommand(pid);
    return commandLine !== null && commandLine.includes(executable);
  }
  return false;
}

function psCommand(pid: number): Promise<string | null> {
  return new Promise((resolveCommand, reject) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "command="], (error, stdout) => {
      if (error) {
        if ("code" in error && error.code === 1) resolveCommand(null);
        else reject(error);
        return;
      }
      resolveCommand(stdout.trim() || null);
    });
  });
}

async function isExecutable(
  path: string,
  runtime: Pick<WorkerRuntime, "canExecute">,
): Promise<boolean> {
  try {
    await runtime.canExecute(path);
    return true;
  } catch {
    return false;
  }
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    child.once("error", (error) =>
      settle(() => reject(isNotFoundError(error) ? workerNotFound() : error)),
    );
    child.once("close", (code, signal) =>
      settle(() => resolveExit(code ?? exitCodeForSignal(signal))),
    );
  });
}

export function parseDoctorReport(output: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new CliError(
      "DOCTOR_INVALID_REPORT",
      "The worker doctor did not return valid JSON.",
      ExitCode.Unexpected,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "DOCTOR_INVALID_REPORT",
      "The worker doctor did not return a JSON object.",
      ExitCode.Unexpected,
    );
  }
  return parsed as Record<string, unknown>;
}

export function tryParseDoctorReport(output: string): Record<string, unknown> | undefined {
  try {
    return parseDoctorReport(output);
  } catch {
    return undefined;
  }
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (signal === null) return ExitCode.Unexpected;
  return 128 + (constants.signals[signal] ?? 0);
}

function isNotFoundError(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && isNotFoundError(error);
}

function isProcessNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function workerNotFound(): CliError {
  return new CliError(
    "WORKER_NOT_FOUND",
    "pidgen-worker was not found. Set PIDGEN_WORKER_BIN or add it to PATH.",
    ExitCode.Usage,
  );
}
