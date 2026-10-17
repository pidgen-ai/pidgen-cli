import { join } from "node:path";
import { z } from "zod";
import type { RunContext } from "./context.js";
import { check, type DoctorCheck } from "./doctor.js";
import { CliError } from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import { provenanceInvalid, verifyImage, type CosignRunner } from "./provenance.js";
import type { InstallRecord, WorkerAdapter } from "./worker-install.js";
import type { ResolvedRelease } from "./worker-index.js";
import {
  defaultWorkerRuntime,
  displayCommand,
  findOnPath,
  logTail,
  parseDoctorReport,
  resolvePidgenHome,
  runForeground,
  tryParseDoctorReport,
  workerEnvironment,
  type WorkerConfig,
  type WorkerRuntime,
} from "./worker.js";

/**
 * The container runtime: the worker's public image, verified by its cosign signature and pulled
 * by digest, run as one named container with a Docker volume for the worker home.
 *
 * - `install` verifies the image with the provenance module (`cosign verify` against an accepted
 *   identity at `<reference>@<digest>`), and only then runs `docker pull <reference>@<digest>`
 *   and creates the volume. Nothing is pulled or run before the signature verifies.
 * - `start` runs `docker run --name pidgen-worker --volume pidgen-worker-home:/pidgen …` on the
 *   pinned image; `stop`, `status`, `doctor` (`docker exec … pidgen-worker doctor --json`) and
 *   `uninstall` act on that container. The container carries the worker's arguments in a label,
 *   so `worker update --restart` starts the new image with them.
 * - `reinstall` (a `worker update` rollback) verifies the recorded image's signature again before
 *   it pulls it.
 *
 * Docker and cosign are prerequisites the CLI never installs. Every docker command that changes
 * something is printed to standard error before it runs, and every command runs with an argument
 * list, never through a shell.
 */

/** The container the worker runs in. */
export const CONTAINER_NAME = "pidgen-worker";
/** The Docker volume holding the worker home: its credential, configuration and state. */
export const WORKER_VOLUME = "pidgen-worker-home";
/** Where the worker home is mounted in the container; `PIDGEN_HOME` points at it. */
export const CONTAINER_HOME = "/pidgen";
/** The container label recording the worker's arguments, so `worker update --restart` reuses them. */
export const ARGS_LABEL = "ai.pidgen.worker.args";

const DOCKER_INSTALL_URL = "https://docs.docker.com/get-started/get-docker/";
const COSIGN_INSTALL_URL = "https://docs.sigstore.dev/cosign/system_config/installation/";
const STARTUP_WAIT_MS = 2_000;
const STOP_POLL_MS = 100;
const STDERR_LIMIT = 2_000;
const REINSTALL = "pidgen worker install --force";

/** How to install what the container runtime needs; the CLI never installs it. */
export const CONTAINER_INSTRUCTIONS = {
  requires: "docker and cosign",
  instructions: `Install Docker (${DOCKER_INSTALL_URL}) and cosign (${COSIGN_INSTALL_URL}), then run pidgen worker install --runtime container again.`,
  urls: { docker: DOCKER_INSTALL_URL, cosign: COSIGN_INSTALL_URL },
} as const;

/** The worker's container, as `docker inspect` reports it. */
export interface ContainerRecord {
  container: string;
  id: string;
  /** The image it runs: `<reference>@<digest>`. */
  image: string;
  volume: string;
  /** Docker's state: `running`, `exited`, `created`, … */
  status: string;
  started_at: string;
  /** The arguments `pidgen worker start` passed to `pidgen-worker`. */
  args: string[];
}

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker`. The real one is `dockerRunner`; tests inject a fake, so they never reach a
 * Docker daemon or a registry.
 */
export interface DockerRunner {
  /**
   * Runs `docker <args>` and resolves with its status. Its output is captured, or, with
   * `progress`, sent to the CLI's standard error (and not captured).
   */
  run(args: readonly string[], options?: { progress?: boolean }): Promise<DockerResult>;
  /**
   * Runs `docker <args>` in the foreground with inherited standard streams, forwarding `SIGINT`
   * and `SIGTERM`, and resolves with its exit status.
   */
  foreground(args: readonly string[]): Promise<number>;
}

/** The real `docker`, found on the configuration's `PATH`. */
export function dockerRunner(
  config: WorkerConfig,
  runtime: WorkerRuntime = defaultWorkerRuntime,
): DockerRunner {
  const docker = async (): Promise<string> => {
    const found = await findOnPath(config, "docker", runtime);
    if (found === null) throw containerUnavailable(["docker"]);
    return found;
  };
  return {
    async run(args, options = {}) {
      const command = await docker();
      const target = options.progress ? 2 : "pipe";
      const child = runtime.spawn(command, [...args], {
        cwd: config.cwd,
        env: workerEnvironment(config),
        stdio: ["ignore", target, target],
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: string | Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk: string | Buffer) => stderr.push(Buffer.from(chunk)));
      return new Promise((resolve, reject) => {
        let settled = false;
        child.once("error", (error: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          reject(error.code === "ENOENT" ? containerUnavailable(["docker"]) : error);
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          resolve({
            exitCode: code ?? ExitCode.Unexpected,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
    },
    async foreground(args) {
      return runForeground(config, await docker(), args, runtime, () =>
        containerUnavailable(["docker"]),
      );
    },
  };
}

/** `RUNTIME_UNAVAILABLE` (exit 2): the container runtime's prerequisites are missing. */
export function containerUnavailable(missing: readonly string[]): CliError {
  return new CliError(
    "RUNTIME_UNAVAILABLE",
    `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} required to run the worker as a container and ${missing.length === 1 ? "was" : "were"} not found on PATH. ${CONTAINER_INSTRUCTIONS.instructions}`,
    ExitCode.Usage,
    { missing: [...missing], install: { container: CONTAINER_INSTRUCTIONS } },
  );
}

/**
 * The image repository a release's reference names, without its tag: the reference cosign
 * verifies and docker pulls, pinned to the release's digest. A reference that already pins a
 * different digest is refused.
 */
export function imageRepository(reference: string, digest: string): string {
  let repository = reference;
  const at = repository.indexOf("@");
  if (at !== -1) {
    const pinned = repository.slice(at + 1);
    repository = repository.slice(0, at);
    if (pinned !== digest) {
      throw provenanceInvalid(
        reference,
        "digest",
        `The release names the image ${reference}, which pins ${pinned}, but names ${digest} as its digest.`,
        { digest, pinned },
      );
    }
  }
  const tag = repository.indexOf(":", repository.lastIndexOf("/") + 1);
  return tag === -1 ? repository : repository.slice(0, tag);
}

const InspectSchema = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      State: z.object({
        Status: z.string(),
        Running: z.boolean(),
        StartedAt: z.string(),
      }),
      Config: z.object({
        Image: z.string(),
        Labels: z.record(z.string(), z.string()).nullable().optional(),
      }),
    }),
  )
  .min(1);

const DAEMON_UNREACHABLE = /cannot connect to the docker daemon|is the docker daemon running/i;

/** A failed docker command: the daemon unreachable is exit 2, anything else exit 1. */
function dockerFailed(args: readonly string[], result: DockerResult): CliError {
  const stderr = result.stderr.trim().slice(-STDERR_LIMIT);
  if (DAEMON_UNREACHABLE.test(stderr)) {
    return new CliError(
      "RUNTIME_UNAVAILABLE",
      "The Docker daemon cannot be reached. Start Docker and run the command again.",
      ExitCode.Usage,
      { stderr, install: { container: CONTAINER_INSTRUCTIONS } },
    );
  }
  return new CliError(
    "DOCKER_FAILED",
    `docker ${args[0]} exited with status ${result.exitCode}${stderr === "" ? "." : `: ${stderr.split("\n").at(-1)}`}`,
    ExitCode.Unexpected,
    { command: ["docker", ...args], exit_code: result.exitCode, stderr },
  );
}

function workerNotRunning(name: string, record: ContainerRecord | null): CliError {
  return new CliError(
    "WORKER_NOT_RUNNING",
    `The worker's container ${name} is not running. Start it with \`pidgen worker start --detach\`.`,
    ExitCode.NotFound,
    record ? { record } : {},
  );
}

/** The arguments a container was started with, from its label; none when it has no label. */
function recordedArgs(labels: Record<string, string> | null | undefined): string[] {
  const value = labels?.[ARGS_LABEL];
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // An unreadable label is the same as none.
  }
  return [];
}

/**
 * The container adapter. `loadRecord` reads the install record each time the adapter acts, so
 * after `worker update` rewrites it the adapter starts the new image (and, on a rollback, the
 * previous one again).
 */
export function containerAdapter(
  ctx: RunContext,
  loadRecord: () => Promise<InstallRecord | null>,
): WorkerAdapter {
  const docker = ctx.docker;
  const print = (argv: readonly string[]) => ctx.io.stderr(`$ ${displayCommand(argv)}\n`);
  /** A docker command that changes something: printed first. */
  const change = (args: readonly string[], progress = false) => {
    print(["docker", ...args]);
    return docker.run(args, { progress });
  };
  const cosign: CosignRunner = {
    run: (args) => {
      print(["cosign", ...args]);
      return ctx.cosign.run(args);
    },
  };
  const identities = () =>
    ctx.provenanceTrust(join(resolvePidgenHome(ctx), "cache", "sigstore")).identities;

  const installed = async (): Promise<InstallRecord> => {
    const record = await loadRecord();
    if (record === null) {
      throw new CliError(
        "WORKER_NOT_INSTALLED",
        "No worker install record was found. Run `pidgen worker install` first.",
        ExitCode.NotFound,
      );
    }
    return record;
  };
  const pinned = (installRecord: InstallRecord) =>
    `${installRecord.artifact}@${installRecord.digest}`;
  const nameOf = (installRecord: InstallRecord) => installRecord.location || CONTAINER_NAME;
  const volumeOf = (installRecord: InstallRecord) => installRecord.volume ?? WORKER_VOLUME;

  /** The container's record and whether it runs; no record when there is no container. */
  const inspect = async (
    installRecord: InstallRecord,
  ): Promise<{ record: ContainerRecord | null; running: boolean }> => {
    const name = nameOf(installRecord);
    const args = ["inspect", "--type", "container", name];
    const result = await docker.run(args);
    if (result.exitCode !== 0) {
      if (/no such (container|object)/i.test(result.stderr))
        return { record: null, running: false };
      throw dockerFailed(args, result);
    }
    let parsed: z.infer<typeof InspectSchema> | undefined;
    try {
      const candidate = InspectSchema.safeParse(JSON.parse(result.stdout));
      if (candidate.success) parsed = candidate.data;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      throw new CliError(
        "DOCKER_FAILED",
        `docker inspect returned output for ${name} that could not be read.`,
        ExitCode.Unexpected,
        { command: ["docker", ...args] },
      );
    }
    const [container] = parsed as [z.infer<typeof InspectSchema>[number]];
    return {
      record: {
        container: container.Name.replace(/^\//, ""),
        id: container.Id,
        image: container.Config.Image,
        volume: volumeOf(installRecord),
        status: container.State.Status,
        started_at: container.State.StartedAt,
        args: recordedArgs(container.Config.Labels),
      },
      running: container.State.Running,
    };
  };

  /** Removes a stopped container; one already gone is fine. */
  const remove = async (name: string, force = false): Promise<void> => {
    const args = force ? ["rm", "--force", name] : ["rm", name];
    const result = await change(args);
    if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
      throw dockerFailed(args, result);
    }
  };

  /**
   * Verifies the image's cosign signature over its digest for an accepted publisher identity, and
   * only then pulls `<reference>@<digest>`. Nothing is pulled or run before the signature verifies.
   */
  const verifyAndPull = async (reference: string, digest: string, version: string) => {
    const verified = await verifyImage({ reference, digest }, identities(), cosign);
    const verifiedAt = new Date(ctx.now()).toISOString();
    const pullArgs = ["pull", verified.pullReference];
    const pull = await change(pullArgs, true);
    if (pull.exitCode !== 0) {
      const failure = dockerFailed(pullArgs, pull);
      if (failure.code === "RUNTIME_UNAVAILABLE") throw failure;
      throw new CliError(
        "INSTALL_FAILED",
        `docker pull exited with status ${pull.exitCode}; the worker image ${version} was not installed.`,
        ExitCode.Unexpected,
        { exit_code: pull.exitCode, image: verified.pullReference },
      );
    }
    return { verified, verifiedAt };
  };

  /** The digest a tag points at now, read from the registry without pulling anything. */
  const resolveDigest = async (reference: string): Promise<string> => {
    const args = ["buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"];
    const result = await docker.run(args);
    if (result.exitCode !== 0) throw dockerFailed(args, result);
    let digest: unknown;
    try {
      digest = (JSON.parse(result.stdout) as { digest?: unknown }).digest;
    } catch {
      digest = undefined;
    }
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new CliError(
        "UNEXPECTED_RESPONSE",
        `The registry did not name a digest for ${reference}.`,
        ExitCode.Unexpected,
        { reference },
      );
    }
    return digest;
  };

  const prerequisite = async (): Promise<string> => {
    const [dockerPath, cosignPath] = await Promise.all([
      findOnPath(ctx, "docker", ctx.workerRuntime),
      findOnPath(ctx, "cosign", ctx.workerRuntime),
    ]);
    const missing = [dockerPath === null && "docker", cosignPath === null && "cosign"].filter(
      (name): name is string => name !== false,
    );
    if (missing.length > 0) throw containerUnavailable(missing);
    return dockerPath!;
  };

  return {
    form: "container",
    prerequisite,

    async install(release: ResolvedRelease) {
      const image = release.container;
      if (image === null) {
        throw new CliError(
          "RELEASE_UNSUPPORTED",
          `Worker release ${release.version} is not published as a container image.`,
          ExitCode.Refused,
          { version: release.version, form: "container" },
        );
      }
      await prerequisite();
      // The server names a tag that follows the series (repository:X.Y); pin what it points at
      // now, then verify the signature over exactly that digest.
      const digest = await resolveDigest(image.reference);
      const repository = imageRepository(image.reference, digest);

      // Provenance first: nothing is pulled or run until cosign verifies the signature over this
      // digest for an accepted publisher identity.
      const { verified, verifiedAt } = await verifyAndPull(repository, digest, release.version);
      const volumeArgs = ["volume", "create", WORKER_VOLUME];
      const volume = await change(volumeArgs);
      if (volume.exitCode !== 0) throw dockerFailed(volumeArgs, volume);

      return {
        form: "container",
        version: release.version,
        artifact: repository,
        digest,
        identity: verified.signer,
        verified_at: verifiedAt,
        installed_at: new Date(ctx.now()).toISOString(),
        location: CONTAINER_NAME,
        file: null,
        volume: WORKER_VOLUME,
      };
    },

    async reinstall(installRecord) {
      await prerequisite();
      // The recorded image is verified again before it is pulled: a rollback runs nothing whose
      // signature no longer verifies.
      await verifyAndPull(installRecord.artifact, installRecord.digest, installRecord.version);
    },

    async verify(installRecord) {
      const checks: DoctorCheck[] = [];
      const image = pinned(installRecord);
      const args = ["image", "inspect", "--format", "{{json .RepoDigests}}", image];
      const present = await docker.run(args);
      if (present.exitCode !== 0 && DAEMON_UNREACHABLE.test(present.stderr)) {
        throw dockerFailed(args, present);
      }
      let digests: unknown;
      try {
        digests = present.exitCode === 0 ? JSON.parse(present.stdout) : null;
      } catch {
        digests = null;
      }
      checks.push(
        Array.isArray(digests) && digests.includes(image)
          ? check("digest", "ok", `The image ${image} is present with the recorded digest.`)
          : check(
              "digest",
              "fail",
              `The image ${image} is not present on this machine.`,
              REINSTALL,
            ),
      );

      try {
        const verified = await verifyImage(
          { reference: installRecord.artifact, digest: installRecord.digest },
          identities(),
          ctx.cosign,
        );
        checks.push(
          check(
            "provenance",
            "ok",
            `The signature of ${image} verifies and was made by an accepted publisher (${verified.signer.issuer}, ${verified.signer.subject}).`,
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

    async start(args, detach) {
      const installRecord = await installed();
      const name = nameOf(installRecord);
      const current = await inspect(installRecord);
      if (current.running) {
        throw new CliError(
          "WORKER_ALREADY_RUNNING",
          `pidgen-worker is already running in the container ${name}.`,
          ExitCode.Refused,
          { record: current.record },
        );
      }
      if (current.record !== null) await remove(name);

      const runArgs = [
        "--name",
        name,
        "--volume",
        `${volumeOf(installRecord)}:${CONTAINER_HOME}`,
        "--env",
        `PIDGEN_HOME=${CONTAINER_HOME}`,
        "--label",
        `${ARGS_LABEL}=${JSON.stringify(args)}`,
        pinned(installRecord),
        ...args,
      ];
      if (!detach) {
        const foreground = ["run", "--rm", "--interactive", ...runArgs];
        print(["docker", ...foreground]);
        return docker.foreground(foreground);
      }

      const detached = ["run", "--detach", ...runArgs];
      const run = await change(detached);
      if (run.exitCode !== 0) throw dockerFailed(detached, run);
      await ctx.sleep(STARTUP_WAIT_MS);

      const started = await inspect(installRecord);
      if (!started.running || started.record === null) {
        const logs = await docker.run(["logs", "--tail", "20", name]);
        throw new CliError(
          "WORKER_EXITED",
          `pidgen-worker exited during startup in the container ${name}.`,
          ExitCode.Unexpected,
          {
            record: started.record,
            log_tail: logTail(`${logs.stdout}${logs.stderr}`),
          },
        );
      }
      return started.record;
    },

    async stop(force, timeoutSeconds) {
      const installRecord = await installed();
      const name = nameOf(installRecord);
      const current = await inspect(installRecord);
      if (!current.running || current.record === null) {
        if (current.record !== null) await remove(name);
        throw workerNotRunning(name, current.record);
      }

      await change(["kill", "--signal", "SIGTERM", name]);
      const deadline = ctx.now() + timeoutSeconds * 1_000;
      let state = await inspect(installRecord);
      while (state.running) {
        const remaining = deadline - ctx.now();
        if (remaining <= 0) break;
        await ctx.sleep(Math.min(STOP_POLL_MS, remaining));
        state = await inspect(installRecord);
      }
      if (!state.running) {
        await remove(name);
        return { record: current.record, forced: false };
      }
      if (!force) {
        throw new CliError(
          "TIMEOUT",
          `pidgen-worker did not stop within ${timeoutSeconds} seconds.`,
          ExitCode.Network,
          { record: current.record, timeout_seconds: timeoutSeconds },
        );
      }
      await change(["kill", name]);
      await remove(name, true);
      return { record: current.record, forced: true };
    },

    status: async () => inspect(await installed()),

    async doctor(args) {
      const installRecord = await installed();
      const name = nameOf(installRecord);
      const current = await inspect(installRecord);
      if (!current.running) throw workerNotRunning(name, current.record);
      const execArgs = ["exec", name, "pidgen-worker", "doctor", "--json", ...args];
      const result = await docker.run(execArgs);
      if (result.exitCode !== ExitCode.Ok) {
        if (DAEMON_UNREACHABLE.test(result.stderr)) throw dockerFailed(execArgs, result);
        throw new CliError(
          "DOCTOR_FAILED",
          "The worker doctor reported a failing check.",
          ExitCode.Unexpected,
          tryParseDoctorReport(result.stdout) ?? {
            output: result.stdout,
            stderr: result.stderr.trim().slice(-STDERR_LIMIT),
          },
        );
      }
      return parseDoctorReport(result.stdout);
    },

    async uninstall(installRecord, purge) {
      const name = nameOf(installRecord);
      // `worker uninstall` stops a running container first; one that still runs is removed by force.
      const current = await inspect(installRecord);
      const removed: string[] = [];
      if (current.record !== null) {
        await remove(name, current.running);
        removed.push(`container ${name}`);
      }

      const image = pinned(installRecord);
      const imageArgs = ["image", "rm", image];
      const imageResult = await change(imageArgs);
      if (imageResult.exitCode === 0) removed.push(`image ${image}`);
      else if (!/no such image/i.test(imageResult.stderr))
        throw dockerFailed(imageArgs, imageResult);

      if (purge) {
        const volume = volumeOf(installRecord);
        const volumeArgs = ["volume", "rm", volume];
        const volumeResult = await change(volumeArgs);
        if (volumeResult.exitCode === 0) removed.push(`volume ${volume}`);
        else if (!/no such volume/i.test(volumeResult.stderr)) {
          throw dockerFailed(volumeArgs, volumeResult);
        }
      }
      return { removed };
    },
  };
}
