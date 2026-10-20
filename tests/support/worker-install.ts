import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { ProvenanceTrust } from "../../src/core/provenance.js";
import type { PublisherIdentity } from "../../src/core/worker-release-identities.js";
import { defaultWorkerRuntime, type WorkerRuntime } from "../../src/core/worker.js";
import { jsonResponse, tempDir, testContext, type TestContext } from "./context.js";
import { WORKER_EULA } from "./published.js";

/**
 * Fakes for `pidgen worker install`, `worker verify` and `pidgen doctor`: a release list shaped by
 * the published document's `WorkerReleaseList`, PyPI answering with the recorded provenance fixtures
 * (tests/fixtures/provenance/), a test trust root and identity, and a fake `uv` on PATH that logs
 * the argument lists it was run with. Nothing reaches a Pidgen server, PyPI or Sigstore.
 */

export const SERVER = "https://pidgen.example.com";
export const RELEASES_URL = `${SERVER}/api/v1/workers/releases`;
export const FIXTURES = join(import.meta.dirname, "..", "fixtures", "provenance");
export const WHEEL = "pidgen_worker-1.0.0-py3-none-any.whl";
export const WHEEL_SHA256 = "3254892dd2b00a6c9251218bee059ada42be1920e549e74047cf99528f883c07";
export const WHEEL_URL = `https://files.pythonhosted.org/packages/py3/p/pidgen-worker/${WHEEL}`;
export const PYPI_JSON_URL = "https://pypi.org/pypi/pidgen-worker/json";
export const TEST_PYPI_JSON_URL = "https://test.pypi.org/pypi/pidgen-worker/json";
export const TEST_PROVENANCE_URL = `https://test.pypi.org/integrity/pidgen-worker/1.0.0/${WHEEL}/provenance`;
export const PROVENANCE_URL = `https://pypi.org/integrity/pidgen-worker/1.0.0/${WHEEL}/provenance`;
export const TEST_ISSUER = "https://issuer.test.example";
export const TEST_SUBJECT =
  "https://github.com/example-org/example-worker/.github/workflows/release.yml@refs/tags/v1.0.0";
export const TEST_IDENTITY: PublisherIdentity = {
  issuer: TEST_ISSUER,
  subject:
    "https://github.com/example-org/example-worker/.github/workflows/release.yml@refs/tags/v*",
};

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;

export function testTrust(identities: readonly PublisherIdentity[] = [TEST_IDENTITY]) {
  return {
    identities,
    trustedRoot: async () => fixture("trusted-root.json"),
  } satisfies ProvenanceTrust;
}

/** One series of the release list. */
export function seriesEntry(series: string, status: "current" | "supported"): ReleaseSeries {
  return {
    series,
    protocol: series,
    status,
    wheel: { project: "pidgen-worker", requirement: `pidgen-worker~=${series}.0` },
    container: { reference: `registry.example.com/example-org/worker:${series}` },
  };
}

/**
 * The release list the tests run against (`data` of the response): series `1.0` is current and
 * `0.9` still supported, so the recorded `1.0.0` wheel is the current series' newest release.
 */
export function releaseList(): ReleaseList {
  return {
    service_protocol: "1.0",
    accepted_protocols: ["1.0", "0.9"],
    current: "1.0",
    releases: [seriesEntry("1.0", "current"), seriesEntry("0.9", "supported")],
    eula: structuredClone(WORKER_EULA),
    // Two harnesses, so the doctor tests can find one and miss another.
    harnesses: [
      { kind: "claude", command: "claude" },
      { kind: "codex", command: "codex" },
    ],
  };
}

export interface ReleaseSeries {
  series: string;
  protocol: string;
  status: "current" | "supported";
  wheel: { project: string; requirement: string };
  container: { reference: string };
}

export interface ReleaseList {
  service_protocol: string;
  accepted_protocols: string[];
  current: string;
  releases: ReleaseSeries[];
  eula: { name: string; location: string; notice: string };
  harnesses: Array<{ kind: string; command: string }>;
}

/** One file of the package index's project listing. */
export interface IndexFile {
  filename: string;
  url: string;
  digests: { sha256: string };
  yanked?: boolean;
}

/** The recorded wheel, as the index lists it. */
export const RECORDED_WHEEL: IndexFile = {
  filename: WHEEL,
  url: WHEEL_URL,
  digests: { sha256: WHEEL_SHA256 },
};

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

export interface InstallFetchOptions {
  /** The release list, or a whole response for the release route. */
  releases?: ReleaseList | Response;
  /** The bytes the wheel download returns. */
  wheel?: Buffer;
  /** The index's releases, version to files (default: `1.0.0` with the recorded wheel). */
  index?: Record<string, IndexFile[]>;
  /** The provenance PyPI returns, or a status with no body. */
  provenance?: unknown;
  provenanceStatus?: number;
}

/** A fetch that answers the release route, PyPI's JSON API, the wheel and its provenance. */
export function installFetch(options: InstallFetchOptions = {}) {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, headers });
    if (url === RELEASES_URL) {
      if (options.releases instanceof Response) return options.releases;
      return jsonResponse(200, { status: "ok", data: options.releases ?? releaseList() });
    }
    if (url === PYPI_JSON_URL || url === TEST_PYPI_JSON_URL) {
      return jsonResponse(200, {
        info: { name: "pidgen-worker" },
        releases: options.index ?? { "1.0.0": [RECORDED_WHEEL] },
      });
    }
    if (url === WHEEL_URL) {
      const bytes = options.wheel ?? (await readFile(join(FIXTURES, WHEEL)));
      return new Response(new Uint8Array(bytes), { status: 200 });
    }
    if (url === PROVENANCE_URL || url === TEST_PROVENANCE_URL) {
      if (options.provenanceStatus !== undefined && options.provenanceStatus !== 200) {
        return new Response(null, { status: options.provenanceStatus });
      }
      return jsonResponse(200, options.provenance ?? fixture("provenance.json"));
    }
    throw new Error(`unexpected network call to ${url}`);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  /** Everything the CLI had written to standard error when it spawned the process. */
  stderrBefore: string;
}

export interface UvRun {
  args: string[];
  /** The `UV_TOOL_DIR` and `UV_TOOL_BIN_DIR` uv was run with (absent: uv's defaults). */
  env?: { UV_TOOL_DIR?: string; UV_TOOL_BIN_DIR?: string };
  /** The sha256 of the file `uv tool install` was given, read when it ran. */
  sha256?: string;
}

/** A start of the fake detached `pidgen-worker`, and the release its installed script came from. */
export interface WorkerStart {
  pid: number;
  /** The version in the wheel filename the fake `uv` installed the started script from. */
  version: string | null;
  args: string[];
  /** Whether it was still running after the startup check (false: it exited early). */
  stayed: boolean;
}

export interface InstallContext {
  ctx: TestContext;
  /** The installed `pidgen-worker` the fake `uv` writes, also set as `PIDGEN_WORKER_BIN`. */
  workerBin: string;
  /** Starts of the fake detached worker, in order. */
  workerStarts: WorkerStart[];
  /** Signals sent to worker processes. */
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  /** Live fake worker processes, pid to executable. */
  processes: Map<number, string>;
  /** Versions whose worker exits during the startup check. */
  crashing: Set<string>;
  directory: string;
  /**
   * The bin directory under the worker home (`<worker home>/worker/bin`), where the CLI's
   * `uv tool install` puts `pidgen-worker`.
   */
  binDir: string;
  /** uv's shared tool bin directory (`~/.local/bin` on a real machine): uv's default. */
  sharedBinDir: string;
  /** uv's shared tool directory (`~/.local/share/uv/tools` on a real machine): uv's default. */
  sharedToolDir: string;
  /** The directory on PATH holding the fake `uv` (and harness commands). */
  pathDir: string;
  spawns: SpawnCall[];
  fetchCalls: FetchCall[];
  uvRuns(): Promise<UvRun[]>;
  pidgenHome: string;
}

export interface InstallContextOptions extends InstallFetchOptions {
  /** Put the fake `uv` on PATH (default true). */
  uv?: boolean;
  /** Make the fake `uv tool install` fail. */
  uvFails?: boolean;
  /** Make the fake `uv tool uninstall` fail. */
  uvUninstallFails?: boolean;
  /** Commands to put on PATH as trivial executables (harness commands). */
  commands?: string[];
  trust?: ProvenanceTrust;
  env?: Record<string, string>;
  /** The contents of /etc/os-release the runtime reads; `null` (the default): unreadable. */
  osRelease?: string | null;
}

export async function installContext(options: InstallContextOptions = {}): Promise<InstallContext> {
  const directory = await tempDir("pidgen-worker-install-");
  const pathDir = join(directory, "path");
  const binDir = join(directory, ".pidgen", "worker", "bin");
  const sharedBinDir = join(directory, "uv-bin");
  const sharedToolDir = join(directory, "uv-tools");
  const uvLog = join(directory, "uv.log");
  await writeExecutable(join(pathDir, "placeholder"), "#!/bin/sh\nexit 0\n");
  if (options.uv !== false) await writeExecutable(join(pathDir, "uv"), fakeUv());
  // A git new enough for the doctor's git check, so no test depends on the machine's own.
  await writeExecutable(join(pathDir, "git"), "#!/bin/sh\necho 'git version 2.43.0'\n");
  for (const command of options.commands ?? []) {
    await writeExecutable(join(pathDir, command), "#!/bin/sh\nexit 0\n");
  }
  const { fetch, calls } = installFetch(options);
  const spawns: SpawnCall[] = [];
  const holder: { ctx?: TestContext } = {};
  const workerBin = join(binDir, "pidgen-worker");
  const workerStarts: WorkerStart[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const processes = new Map<number, string>();
  const crashing = new Set<string>();
  let nextPid = 500;
  const workerRuntime: WorkerRuntime = {
    ...defaultWorkerRuntime,
    platform: "linux",
    // Never the host's /etc/os-release.
    osRelease: () => Promise.resolve(options.osRelease ?? null),
    spawn: (command, args, spawnOptions) => {
      if (command === workerBin && spawnOptions.detached === true) {
        // The detached worker is faked: it "runs" unless its installed version is crashing. A
        // foreground run (such as `pidgen-worker enroll`) runs the installed script itself.
        const pid = nextPid++;
        const script = readFileSync(workerBin, "utf8");
        const version = /pidgen_worker-([^-]+)-/.exec(script)?.[1] ?? null;
        const stayed = version === null || !crashing.has(version);
        if (stayed) processes.set(pid, workerBin);
        workerStarts.push({ pid, version, args: [...args], stayed });
        const child = new EventEmitter() as ChildProcess;
        Object.defineProperty(child, "pid", { value: pid });
        child.unref = () => child;
        return child;
      }
      spawns.push({
        command,
        args: [...args],
        options: spawnOptions,
        stderrBefore: holder.ctx?.err.join("") ?? "",
      });
      return defaultWorkerRuntime.spawn(command, args, spawnOptions);
    },
    isWorkerProcess: async (pid, executable) => processes.get(pid) === executable,
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      processes.delete(pid);
    },
  };
  const trust = options.trust ?? testTrust();
  const ctx = await testContext({
    homeDir: directory,
    cwd: directory,
    env: {
      PIDGEN_API_URL: SERVER,
      PATH: [pathDir, "/usr/bin", "/bin"].join(delimiter),
      FAKE_UV_LOG: uvLog,
      FAKE_UV_BIN: sharedBinDir,
      FAKE_UV_TOOL_DIR: sharedToolDir,
      PIDGEN_WORKER_BIN: workerBin,
      ...(options.uvFails ? { FAKE_UV_FAIL: "1" } : {}),
      ...(options.uvUninstallFails ? { FAKE_UV_UNINSTALL_FAIL: "1" } : {}),
      ...options.env,
    },
    fetch,
    workerRuntime,
    provenanceTrust: () => trust,
  });
  holder.ctx = ctx;
  return {
    ctx,
    workerBin,
    workerStarts,
    signals,
    processes,
    crashing,
    directory,
    binDir,
    sharedBinDir,
    sharedToolDir,
    pathDir,
    spawns,
    fetchCalls: calls,
    pidgenHome: join(directory, ".pidgen"),
    uvRuns: async () => {
      let text: string;
      try {
        text = await readFile(uvLog, "utf8");
      } catch {
        return [];
      }
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as UvRun);
    },
  };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/**
 * A stand-in for `uv` that logs its argument list and installs a trivial `pidgen-worker`, or a copy
 * of the file at `FAKE_UV_WORKER` when that is set, or uninstalls it. Like uv, it puts the tool's
 * environment in `UV_TOOL_DIR` and its executable in `UV_TOOL_BIN_DIR` when they are set, and
 * otherwise in its shared defaults (`FAKE_UV_TOOL_DIR`, `FAKE_UV_BIN`). `uv tool list --show-paths`
 * lists the `pidgen-worker` there, with the version of the wheel it was installed from.
 */
export function fakeUv(): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const env = {};
for (const key of ["UV_TOOL_DIR", "UV_TOOL_BIN_DIR"]) if (process.env[key]) env[key] = process.env[key];
const log = (entry) => fs.appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify({ ...entry, env }) + "\\n");
const bin = process.env.UV_TOOL_BIN_DIR || process.env.FAKE_UV_BIN;
const tools = process.env.UV_TOOL_DIR || process.env.FAKE_UV_TOOL_DIR;
if (args[0] === "tool" && args[1] === "install") {
  const file = args[args.length - 1];
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  log({ args, sha256 });
  if (process.env.FAKE_UV_FAIL) {
    // FAKE_UV_FAIL_LINES: that many numbered lines of output before the failure.
    const lines = Number(process.env.FAKE_UV_FAIL_LINES ?? 0);
    for (let n = 1; n <= lines; n++) process.stderr.write("uv output line " + n + "\\n");
    process.stderr.write("fake uv: install failed\\n");
    process.exit(1);
  }
  // As uv does, it reports what it resolved on standard error.
  process.stderr.write("Resolved 45 packages in 320ms\\nInstalled 1 executable: pidgen-worker\\n");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(tools, "pidgen-worker"), { recursive: true });
  const worker = process.env.FAKE_UV_WORKER
    ? fs.readFileSync(process.env.FAKE_UV_WORKER)
    : "#!/bin/sh\\n# installed from " + path.basename(file) + "\\nexit 0\\n";
  fs.writeFileSync(path.join(bin, "pidgen-worker"), worker, { mode: 0o755 });
  process.exit(0);
}
if (args[0] === "tool" && args[1] === "uninstall") {
  log({ args });
  if (process.env.FAKE_UV_UNINSTALL_FAIL || process.env.FAKE_UV_FAIL) {
    process.stderr.write("fake uv: uninstall failed\\n");
    process.exit(2);
  }
  fs.rmSync(path.join(bin, "pidgen-worker"), { force: true });
  fs.rmSync(path.join(tools, "pidgen-worker"), { recursive: true, force: true });
  process.exit(0);
}
if (args[0] === "tool" && args[1] === "dir" && args[2] === "--bin") {
  log({ args });
  process.stdout.write(bin + "\\n");
  process.exit(0);
}
if (args[0] === "tool" && args[1] === "list") {
  log({ args });
  const worker = path.join(bin, "pidgen-worker");
  // uv says "No tools installed" on standard error; the fake keeps the test output quiet.
  if (!fs.existsSync(worker)) process.exit(0);
  const version = /pidgen_worker-([^-]+)-/.exec(fs.readFileSync(worker, "utf8"))?.[1] ?? "0.0.0";
  const shown = args.includes("--show-paths");
  process.stdout.write("pidgen-worker v" + version + (shown ? " (" + path.join(tools, "pidgen-worker") + ")" : "") + "\\n");
  process.stdout.write("- pidgen-worker" + (shown ? " (" + worker + ")" : "") + "\\n");
  process.exit(0);
}
log({ args });
process.exit(2);
`;
}

export const PREVIOUS_WHEEL = "pidgen_worker-0.8.0-py3-none-any.whl";

/**
 * Stands up an earlier install as `pidgen worker install` would have left it: a kept, verified
 * 0.8.0 wheel under the worker home, its install record, and the `pidgen-worker` uv installed
 * from it. With `legacy`, as an earlier CLI left it: the worker in uv's shared tool slot.
 * Returns the record.
 */
export async function previousInstall(
  setup: InstallContext,
  options: { legacy?: boolean } = {},
): Promise<Record<string, unknown>> {
  const workerDir = join(setup.pidgenHome, "worker");
  const file = join(workerDir, PREVIOUS_WHEEL);
  const bytes = "the 0.8.0 wheel, verified when it was installed";
  await mkdir(workerDir, { recursive: true });
  await writeFile(file, bytes);
  await writeFile(`${file}.provenance.json`, "{}\n");
  // An earlier CLI let uv put the worker in its shared tool slot; this one uses the worker home.
  const location = options.legacy ? join(setup.sharedBinDir, "pidgen-worker") : setup.workerBin;
  await writeExecutable(location, `#!/bin/sh\n# installed from ${PREVIOUS_WHEEL}\nexit 0\n`);
  if (options.legacy) await mkdir(join(setup.sharedToolDir, "pidgen-worker"), { recursive: true });
  const record = {
    form: "wheel",
    version: "0.8.0",
    artifact: "pidgen-worker==0.8.0",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    identity: { issuer: TEST_ISSUER, subject: TEST_SUBJECT },
    verified_at: "2025-10-01T00:00:00.000Z",
    installed_at: "2025-10-01T00:00:00.000Z",
    location,
    file,
  };
  await mkdir(join(setup.pidgenHome, "run"), { recursive: true });
  await writeFile(join(setup.pidgenHome, "run", "pidgen-install.json"), JSON.stringify(record));
  return record;
}
