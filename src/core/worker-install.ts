import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type { GlobalOptions, RunContext } from "./context.js";
import { check, type DoctorCheck } from "./doctor.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import {
  fetchWheelProvenance,
  verifyWheel,
  type ProvenanceTrust,
  type SignerIdentity,
} from "./provenance.js";
import type { SessionMeta } from "./session.js";
import {
  CONTAINER_INSTRUCTIONS,
  containerAdapter,
  type ContainerRecord,
} from "./worker-container.js";
import {
  packageIndex,
  resolveRelease,
  WORKER_PROJECT,
  WORKER_PYTHON,
  type IndexName,
  type PackageIndex,
  type ResolvedRelease,
} from "./worker-index.js";
import {
  WORKER_REHEARSAL_IDENTITIES,
  WORKER_RELEASE_IDENTITIES,
} from "./worker-release-identities.js";
import {
  readWorkerReleases,
  selectSeries,
  type WorkerEula,
  type WorkerReleaseList,
} from "./worker-releases.js";
import {
  assertSupportedPlatform,
  displayCommand,
  findOnPath,
  resolvePidgenHome,
  runWorkerDoctor,
  runWorkerForeground,
  startWorkerDetached,
  stopWorker,
  workerEnvironment,
  workerStatus,
  type WorkerRecord,
} from "./worker.js";

/**
 * Installing the worker and recording what was installed.
 *
 * One interface, `WorkerAdapter`, with one implementation per form, chosen by the install record's
 * `form`. The wheel adapter installs the exact wheel a release names, after its provenance
 * verifies, with `uv tool install`; it runs the installed `pidgen-worker` with the code in
 * `worker.ts`. The container adapter (`worker-container.ts`) verifies the worker image's cosign
 * signature, pulls it by digest and runs it as a named container.
 *
 * The install record lives at `<worker home>/run/pidgen-install.json`, beside the detached
 * worker's run record, and later commands read it, so none of them needs `--runtime`.
 */

export type WorkerForm = "wheel" | "container";
export const WORKER_FORMS: readonly WorkerForm[] = ["wheel", "container"];

/** What `start` and `status` report: the detached process's record, or the container's. */
export type RunRecord = WorkerRecord | ContainerRecord;

/** What was installed, and how it was shown to come from the worker's release workflow. */
export interface InstallRecord {
  form: WorkerForm;
  version: string;
  /** The wheel requirement (`pidgen-worker==<version>`) or the image reference. */
  artifact: string;
  /** `sha256:<64 hex>`: the digest of the verified artifact. */
  digest: string;
  /** The signer the provenance named, which matched an accepted publisher identity. */
  identity: SignerIdentity;
  verified_at: string;
  installed_at: string;
  /** The installed `pidgen-worker`'s path, or the container's name. */
  location: string;
  /**
   * The verified wheel the CLI installed from, kept so `pidgen worker verify` can re-check it;
   * `null` for the container form.
   */
  file: string | null;
  /** The container form's Docker volume holding the worker home. */
  volume?: string;
  /** The package index the wheel came from: `testpypi` for a `--test` install; absent is `pypi`. */
  index?: IndexName;
}

export interface InstallOptions {
  /** Reinstall even when uv already has the tool (`--force`, or replacing a recorded install). */
  reinstall: boolean;
}

/** The runtime adapter: one interface, chosen by the install record's `form`. */
export interface WorkerAdapter {
  readonly form: WorkerForm;
  /** The prerequisite this form needs on the machine, or `RUNTIME_UNAVAILABLE` (exit 2). */
  prerequisite(): Promise<string>;
  install(release: ResolvedRelease, options: InstallOptions): Promise<InstallRecord>;
  /**
   * Installs a recorded install's artifact again, after checking it still has the recorded digest
   * it was verified with (the kept wheel's sha256; the image's cosign signature): how
   * `worker update` rolls back.
   */
  reinstall(record: InstallRecord): Promise<void>;
  /**
   * Removes what `install` put on the machine (the tool and the kept wheel; the container and the
   * pinned image) and returns what it removed. With `purge` the container form also removes the
   * Docker volume holding its worker home. The install record and the host's worker home are the
   * caller's; a running worker is the caller's to stop first.
   */
  uninstall(record: InstallRecord, purge: boolean): Promise<{ removed: string[] }>;
  verify(record: InstallRecord): Promise<DoctorCheck[]>;
  /** The run record with `detach`; otherwise the foreground worker's exit status. */
  start(args: readonly string[], detach: boolean): Promise<RunRecord | number>;
  stop(force: boolean, timeoutSeconds: number): Promise<{ record: RunRecord; forced: boolean }>;
  status(): Promise<{ record: RunRecord | null; running: boolean }>;
  doctor(args: readonly string[]): Promise<Record<string, unknown>>;
}

const RECORD_NAME = "pidgen-install.json";
const UV_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";
/** The fix for an installed worker that no longer verifies: install, and verify, it again. */
const REINSTALL = "pidgen worker install --force";

/** How to install what each form needs; the CLI never installs it. */
export const RUNTIME_INSTRUCTIONS = {
  wheel: {
    requires: "uv",
    instructions: `Install uv (${UV_INSTALL_URL}), then run pidgen worker install again.`,
    url: UV_INSTALL_URL,
  },
  container: CONTAINER_INSTRUCTIONS,
} as const;

/**
 * The adapter for a form. The container adapter reads the install record when it acts, so after
 * `worker update` rewrites the record it runs the new image.
 */
export function adapterFor(ctx: RunContext, form: WorkerForm): WorkerAdapter {
  switch (form) {
    case "wheel":
      return wheelAdapter(ctx);
    case "container":
      return containerAdapter(ctx, () => readInstallRecord(ctx));
  }
}

/**
 * The adapter the install record's form selects, for the commands that act on an installed
 * worker. With no record it is the wheel adapter, which finds `pidgen-worker` on `PATH` or at
 * `PIDGEN_WORKER_BIN`.
 */
export async function installedAdapter(ctx: RunContext): Promise<WorkerAdapter> {
  const record = await readInstallRecord(ctx);
  if (record?.form === "container") assertSupportedPlatform(ctx.workerRuntime);
  return adapterFor(ctx, record?.form ?? "wheel");
}

/**
 * `RUNTIME_UNAVAILABLE` (exit 2): `wheel` when uv is required for `--runtime wheel`;
 * `wheel-only` when the caller installs only the wheel and no uv was found; otherwise neither
 * form's tools were found.
 */
export function runtimeUnavailable(form?: "wheel" | "wheel-only"): CliError {
  return new CliError(
    "RUNTIME_UNAVAILABLE",
    form === "wheel"
      ? `uv is required to install the worker as a wheel and was not found on PATH. ${RUNTIME_INSTRUCTIONS.wheel.instructions}`
      : form === "wheel-only"
        ? `No worker runtime is available: uv was not found on PATH. ${RUNTIME_INSTRUCTIONS.wheel.instructions}`
        : `No worker runtime is available: neither uv nor docker with cosign was found on PATH. ${RUNTIME_INSTRUCTIONS.wheel.instructions} Or: ${RUNTIME_INSTRUCTIONS.container.instructions}`,
    ExitCode.Usage,
    { install: RUNTIME_INSTRUCTIONS },
  );
}

// ---------------------------------------------------------------------------------------------
// Installing: the one install `pidgen worker install` and `pidgen worker enroll` share

export interface InstallWorkerOptions {
  /** `--runtime`; without it the install record decides, then what the machine has. */
  runtime?: WorkerForm | undefined;
  /** `--version`; without it the newest release of the server's `current` series. */
  version?: string | undefined;
  /** `--test`: install a rehearsal from TestPyPI, where development builds are candidates. */
  test?: boolean | undefined;
  /** Reinstall the recorded version. */
  force: boolean;
  /**
   * The forms the machine's tools may select when neither `runtime` nor the install record
   * decides, in order: `uv` selects `wheel`, `docker` with `cosign` selects `container`. Without it,
   * only `wheel`.
   */
  detect?: readonly WorkerForm[];
  /**
   * Called once the release is chosen and the form's prerequisite is present, before the licence
   * notice is printed and anything is downloaded or run. Throwing stops the install.
   */
  beforeInstall?: (release: ResolvedRelease, list: WorkerReleaseList) => Promise<void>;
}

export interface InstalledWorker {
  record: InstallRecord;
  /** `false` when the recorded version was already installed and nothing ran. */
  installed: boolean;
  meta: SessionMeta;
}

/**
 * Installs the worker: reads the server's release list with no credential, picks the release,
 * prints the licence notice, verifies the release's artifact against the worker's release
 * identity, and only then installs it and writes the install record. Installing the recorded
 * version again does nothing unless `force`. Every command it runs is printed to standard error
 * first and run with an argument list, never through a shell.
 */
export async function installWorker(
  ctx: RunContext,
  global: Pick<GlobalOptions, "profile" | "account" | "timeoutSeconds">,
  options: InstallWorkerOptions,
): Promise<InstalledWorker> {
  const record = await readInstallRecord(ctx);
  const form = await chooseForm(ctx, options.runtime, record?.form, options.detect ?? ["wheel"]);

  const { list, meta } = await readWorkerReleases(ctx, global);
  const series = selectSeries(list, options.version);
  const index = packageIndex(options.test === true);
  const release = await resolveRelease(ctx, series, index, options.version);
  if (!options.force && record?.form === form && record.version === release.version) {
    return { record, installed: false, meta };
  }

  const adapter = adapterFor(ctx, form);
  await adapter.prerequisite();
  await options.beforeInstall?.(release, list);
  ctx.io.stderr(licenceNotice(list.eula));
  const installed = await adapter.install(release, {
    reinstall: options.force || record !== null,
  });
  await writeInstallRecord(ctx, installed);
  if (record !== null && record.file !== installed.file) await removeKeptArtifact(record);
  return { record: installed, installed: true, meta };
}

/**
 * `--runtime`, else the recorded form, else what the machine has, among `detect`: `uv` means
 * `wheel`, and `docker` with `cosign` means `container`.
 */
async function chooseForm(
  ctx: RunContext,
  option: WorkerForm | undefined,
  recorded: WorkerForm | undefined,
  detect: readonly WorkerForm[],
): Promise<WorkerForm> {
  if (option !== undefined) return option;
  if (recorded !== undefined) return recorded;
  for (const form of detect) {
    const tools = form === "wheel" ? ["uv"] : ["docker", "cosign"];
    const found = await Promise.all(tools.map((tool) => findOnPath(ctx, tool, ctx.workerRuntime)));
    if (found.every((path) => path !== null)) return form;
  }
  throw runtimeUnavailable(detect.includes("container") ? undefined : "wheel-only");
}

/** The worker's licence notice, as `pidgen worker install`, `pidgen worker update` and `pidgen setup` print it. */
export function licenceNotice(eula: WorkerEula): string {
  return [
    `pidgen-worker is licensed under the ${eula.name} (${eula.location}).`,
    eula.notice,
    "Installing it accepts the licence.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The install record

export function installRecordPath(ctx: Pick<RunContext, "env" | "homeDir">): string {
  return join(resolvePidgenHome(ctx), "run", RECORD_NAME);
}

const IdentitySchema = z.object({ issuer: z.string(), subject: z.string() });
const RecordSchema = z.object({
  form: z.enum(WORKER_FORMS as [WorkerForm, ...WorkerForm[]]),
  version: z.string().min(1),
  artifact: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  identity: IdentitySchema,
  verified_at: z.string(),
  installed_at: z.string(),
  location: z.string(),
  file: z.string().min(1).nullable(),
  volume: z.string().min(1).optional(),
  index: z.enum(["pypi", "testpypi"]).optional(),
});

/** The install record, or `null` when there is none. A record that cannot be read is an error. */
export async function readInstallRecord(
  ctx: Pick<RunContext, "env" | "homeDir">,
): Promise<InstallRecord | null> {
  const path = installRecordPath(ctx);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const result = RecordSchema.safeParse(parsed);
  if (!result.success || (result.data.form === "wheel" && result.data.file === null)) {
    throw new CliError(
      "INSTALL_RECORD_INVALID",
      `The worker install record at ${path} cannot be read. Run \`pidgen worker install --force\` to replace it.`,
      ExitCode.Unexpected,
      { path },
    );
  }
  const { volume, index, ...record } = result.data;
  return {
    ...record,
    ...(volume === undefined ? {} : { volume }),
    ...(index === undefined ? {} : { index }),
  };
}

export async function writeInstallRecord(
  ctx: Pick<RunContext, "env" | "homeDir">,
  record: InstallRecord,
): Promise<void> {
  const path = installRecordPath(ctx);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const staged = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(staged, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(staged, path);
}

/** Removes the install record; the installed tool is the adapter's to remove. */
export async function removeInstallRecord(ctx: Pick<RunContext, "env" | "homeDir">): Promise<void> {
  await rm(installRecordPath(ctx), { force: true });
}

/** Removes the wheel (and its attestation) a superseded install record kept. */
export async function removeKeptArtifact(record: InstallRecord): Promise<void> {
  if (record.file === null) return;
  await rm(record.file, { force: true });
  await rm(`${record.file}.provenance.json`, { force: true });
}

export function noInstallRecord(): CliError {
  return new CliError(
    "WORKER_NOT_INSTALLED",
    "No worker install record was found. Run `pidgen worker install` first.",
    ExitCode.NotFound,
  );
}

// ---------------------------------------------------------------------------------------------
// Running commands

export interface CommandResult {
  exitCode: number;
  stdout: string;
}

/**
 * Runs a command the CLI composed: prints it to standard error, then runs it with an argument
 * list, never through a shell. Its standard error goes to the CLI's; its standard output is
 * captured when `capture` is set and otherwise also goes to standard error, so standard output
 * keeps only the envelope.
 */
export async function runCommand(
  ctx: RunContext,
  argv: readonly [string, ...string[]],
  options: { capture?: boolean } = {},
): Promise<CommandResult> {
  const [command, ...args] = argv;
  ctx.io.stderr(`$ ${displayCommand(argv)}\n`);
  const child = ctx.workerRuntime.spawn(command, args, {
    cwd: ctx.cwd,
    env: workerEnvironment(ctx),
    stdio: ["ignore", options.capture ? "pipe" : 2, 2],
    shell: false,
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)));
  const exitCode = await waitFor(child, command);
  return { exitCode, stdout: Buffer.concat(chunks).toString("utf8") };
}

/** A shell-safe rendering of one argument, for display only. */
export function displayArgument(argument: string): string {
  return displayCommand([argument]);
}

function waitFor(child: ChildProcess, command: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    let settled = false;
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(
        error.code === "ENOENT"
          ? new CliError("RUNTIME_UNAVAILABLE", `${command} could not be run.`, ExitCode.Usage, {
              install: RUNTIME_INSTRUCTIONS,
            })
          : error,
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolveExit(code ?? ExitCode.Unexpected);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The wheel adapter

export function wheelAdapter(ctx: RunContext): WorkerAdapter {
  const trust = (): ProvenanceTrust =>
    ctx.provenanceTrust(join(resolvePidgenHome(ctx), "cache", "sigstore"));

  const prerequisite = async (): Promise<string> => {
    const uv = await findOnPath(ctx, "uv", ctx.workerRuntime);
    if (uv === null) throw runtimeUnavailable("wheel");
    return uv;
  };

  return {
    form: "wheel",
    prerequisite,

    async install(release, options) {
      const wheel = release.wheel;
      if (wheel === null) {
        throw new CliError(
          "RELEASE_UNSUPPORTED",
          `Worker release ${release.version} is not published as a wheel.`,
          ExitCode.Refused,
          { version: release.version, form: "wheel" },
        );
      }
      checkWheelNames(release.version, wheel);
      const uv = await prerequisite();
      const expectedSha256 = wheel.digest.slice("sha256:".length);
      const index = release.index;

      const workerDir = join(resolvePidgenHome(ctx), "worker");
      await mkdir(workerDir, { recursive: true, mode: 0o700 });
      const staging = join(workerDir, `.staging-${randomBytes(6).toString("hex")}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        // Provenance first: a release with no attestation is refused before anything is downloaded.
        const provenance = await fetchWheelProvenance(
          ctx.fetch,
          { project: WORKER_PROJECT, version: release.version, filename: wheel.filename },
          index.url,
        );
        const staged = join(staging, wheel.filename);
        await downloadWheel(ctx, wheel.url, wheel.filename, staged);
        const verified = await verifyWheel(
          { path: staged, filename: wheel.filename, expectedSha256 },
          provenance,
          trustFor(trust(), index),
        );
        const verifiedAt = new Date(ctx.now()).toISOString();

        // Only now does anything run: uv installs the verified file into its own environment,
        // with the interpreter the wheel was chosen for (a compiled wheel serves one Python).
        const install = await runCommand(ctx, [
          uv,
          "tool",
          "install",
          "--python",
          WORKER_PYTHON,
          ...(options.reinstall ? ["--reinstall"] : []),
          staged,
        ]);
        if (install.exitCode !== 0) {
          throw new CliError(
            "INSTALL_FAILED",
            `uv tool install exited with status ${install.exitCode}; pidgen-worker ${release.version} was not installed.`,
            ExitCode.Unexpected,
            { exit_code: install.exitCode },
          );
        }
        const bin = await runCommand(ctx, [uv, "tool", "dir", "--bin"], { capture: true });
        const binDir = bin.exitCode === 0 ? bin.stdout.trim() : "";
        const location =
          binDir !== ""
            ? join(binDir, "pidgen-worker")
            : ((await findOnPath(ctx, "pidgen-worker", ctx.workerRuntime)) ?? "pidgen-worker");

        const file = join(workerDir, wheel.filename);
        await rename(staged, file);
        await writeFile(`${file}.provenance.json`, `${JSON.stringify(provenance)}\n`, {
          mode: 0o600,
        });
        return {
          form: "wheel",
          version: release.version,
          artifact: wheel.requirement,
          digest: `sha256:${verified.sha256}`,
          identity: verified.identity,
          verified_at: verifiedAt,
          installed_at: new Date(ctx.now()).toISOString(),
          location,
          file,
          ...(index.name === "pypi" ? {} : { index: index.name }),
        };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },

    async reinstall(record) {
      const uv = await prerequisite();
      const expected = record.digest.slice("sha256:".length);
      const file = record.file ?? "";
      let sha256: string | null;
      try {
        sha256 = file === "" ? null : await fileSha256(file);
      } catch {
        sha256 = null;
      }
      if (sha256 !== expected) {
        throw new CliError(
          "PROVENANCE_INVALID",
          sha256 === null
            ? `The kept wheel ${file} of pidgen-worker ${record.version} is missing.`
            : `The kept wheel ${file} of pidgen-worker ${record.version} no longer has its recorded digest.`,
          ExitCode.Refused,
          { check: "digest", file: record.file, expected: record.digest },
        );
      }
      const install = await runCommand(ctx, [
        uv,
        "tool",
        "install",
        "--python",
        WORKER_PYTHON,
        "--reinstall",
        file,
      ]);
      if (install.exitCode !== 0) {
        throw new CliError(
          "INSTALL_FAILED",
          `uv tool install exited with status ${install.exitCode}; pidgen-worker ${record.version} was not reinstalled.`,
          ExitCode.Unexpected,
          { exit_code: install.exitCode },
        );
      }
    },

    async uninstall(record) {
      const uv = await prerequisite();
      const result = await runCommand(ctx, [uv, "tool", "uninstall", WORKER_PROJECT]);
      // uv refuses a tool it no longer has; one removed outside the CLI is already uninstalled.
      if (result.exitCode !== 0 && (await pathExists(record.location))) {
        throw new CliError(
          "UNINSTALL_FAILED",
          `uv tool uninstall exited with status ${result.exitCode}; pidgen-worker ${record.version} is still installed.`,
          ExitCode.Unexpected,
          { exit_code: result.exitCode, location: record.location },
        );
      }
      const removed = [`tool ${WORKER_PROJECT}`];
      if (record.file !== null) {
        await removeKeptArtifact(record);
        removed.push(`file ${record.file}`);
      }
      return { removed };
    },

    async verify(installRecord) {
      const checks: DoctorCheck[] = [];
      const file = installRecord.file ?? "";
      const filename = basename(file);
      const expected = installRecord.digest.slice("sha256:".length);
      let sha256: string | null;
      try {
        sha256 = file === "" ? null : await fileSha256(file);
      } catch {
        sha256 = null;
      }
      if (sha256 === null) {
        checks.push(check("digest", "fail", `The installed wheel ${file} is missing.`, REINSTALL));
      } else if (sha256 !== expected) {
        checks.push(
          check(
            "digest",
            "fail",
            `The installed wheel ${file} has sha256 ${sha256}, not the recorded ${expected}.`,
            REINSTALL,
          ),
        );
      } else {
        checks.push(
          check(
            "digest",
            "ok",
            `The installed wheel ${file} has the recorded digest ${installRecord.digest}.`,
          ),
        );
      }

      if (sha256 === null) {
        checks.push(
          check("provenance", "fail", "There is no installed wheel to verify.", REINSTALL),
        );
        return checks;
      }
      let provenance: unknown;
      try {
        provenance = JSON.parse(await readFile(`${file}.provenance.json`, "utf8"));
      } catch {
        provenance = null;
      }
      try {
        const verified = await verifyWheel(
          { path: file, filename, expectedSha256: expected },
          provenance,
          trust(),
        );
        checks.push(
          check(
            "provenance",
            "ok",
            `The attestation for ${filename} verifies and was signed by an accepted publisher (${verified.identity.issuer}, ${verified.identity.subject}).`,
          ),
        );
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "PROVENANCE_INVALID") throw error;
        const failed = error.details["check"];
        checks.push(
          check(
            "provenance",
            "fail",
            `${typeof failed === "string" ? `The ${failed} check failed: ` : ""}${error.message}`,
            REINSTALL,
          ),
        );
      }
      return checks;
    },

    start: (args, detach) =>
      detach
        ? startWorkerDetached(ctx, args, ctx.workerRuntime)
        : runWorkerForeground(ctx, args, ctx.workerRuntime),
    stop: (force, timeoutSeconds) => stopWorker(ctx, { force, timeoutSeconds }, ctx.workerRuntime),
    status: () => workerStatus(ctx, ctx.workerRuntime),
    doctor: (args) => runWorkerDoctor(ctx, args, ctx.workerRuntime),
  };
}

/** The release's wheel must be the worker's, for this version. */
function checkWheelNames(version: string, wheel: { requirement: string; filename: string }): void {
  const expectedRequirement = `${WORKER_PROJECT}==${version}`;
  const expectedPrefix = `pidgen_worker-${version}-`;
  if (wheel.requirement !== expectedRequirement || !wheel.filename.startsWith(expectedPrefix)) {
    throw new CliError(
      "UNEXPECTED_RESPONSE",
      `The server's release ${version} names a wheel that is not pidgen-worker ${version}.`,
      ExitCode.Unexpected,
      { requirement: wheel.requirement, filename: wheel.filename },
    );
  }
}

/** Downloads the wheel the package index publishes at `url` (already checked to be https). */
async function downloadWheel(
  ctx: RunContext,
  url: string,
  filename: string,
  path: string,
): Promise<void> {
  const response = await fetchOrFail(ctx, url, filename);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
}

/**
 * The trust for an install from `index`: a TestPyPI install also accepts the release workflow
 * run from a branch (a rehearsal). An injected trust (tests) is left as it is.
 */
export function trustFor(base: ProvenanceTrust, index: PackageIndex): ProvenanceTrust {
  if (index.name === "testpypi" && base.identities === WORKER_RELEASE_IDENTITIES) {
    return { ...base, identities: WORKER_REHEARSAL_IDENTITIES };
  }
  return base;
}

async function fetchOrFail(ctx: RunContext, url: string, filename: string): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new CliError(
      timedOut ? "TIMEOUT" : "NETWORK",
      `Could not download ${filename} from ${new URL(url).origin}.`,
      ExitCode.Network,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!response.ok) {
    throw new CliError(
      "DOWNLOAD_FAILED",
      `${new URL(url).origin} answered ${response.status} for ${filename}.`,
      ExitCode.Unexpected,
      { status: response.status, filename },
    );
  }
  return response;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
