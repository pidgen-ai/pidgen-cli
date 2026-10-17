import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import { dockerRunner, imageRepository } from "../../src/core/worker-container.js";
import { WORKER_RELEASE_IDENTITIES } from "../../src/core/worker-release-identities.js";
import { defaultWorkerRuntime } from "../../src/core/worker.js";
import { envelope, tempDir, testContext } from "../support/context.js";
import {
  CONTAINER_NAME,
  containerContext,
  fakeCosign,
  IMAGE_DIGEST,
  IMAGE_REFERENCE,
  PINNED_IMAGE,
  VOLUME_NAME,
  type ContainerContextOptions,
} from "../support/worker-container.js";
import { releaseList, TEST_ISSUER, TEST_SUBJECT, testTrust } from "../support/worker-install.js";

/**
 * The container runtime, end to end through the commands, against a fake docker and a fake
 * cosign that answer with recorded output (AC-e521c9a6ddbd: never a real registry or daemon).
 */

async function readRecord(pidgenHome: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(pidgenHome, "run", "pidgen-install.json"), "utf8"));
}

async function hasRecord(pidgenHome: string): Promise<boolean> {
  try {
    await readRecord(pidgenHome);
    return true;
  } catch {
    return false;
  }
}

/** A container install, done; the output and the tool log are cleared for the next command. */
async function installed(options: ContainerContextOptions = {}) {
  const setup = await containerContext(options);
  expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
    ExitCode.Ok,
  );
  setup.ctx.out.length = 0;
  setup.ctx.err.length = 0;
  setup.log.length = 0;
  return setup;
}

function data(ctx: Parameters<typeof envelope>[0]): Record<string, unknown> {
  return envelope(ctx)["data"] as Record<string, unknown>;
}

describe("pidgen worker install --runtime container", () => {
  // AC-981b8b967540: the signature is verified with the provenance module (cosign verify against
  // an accepted identity at reference@digest), and only then is reference@digest pulled.
  it("verifies the image's cosign signature, then pulls reference@digest", async () => {
    const setup = await containerContext();

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Ok,
    );

    // The tag the server names is resolved to a digest first; that lookup reads the registry
    // and changes nothing.
    expect(setup.log[0]).toEqual({
      tool: "docker",
      args: [
        "buildx",
        "imagetools",
        "inspect",
        `${IMAGE_REFERENCE}:1.0`,
        "--format",
        "{{json .Manifest}}",
      ],
      mode: "capture",
    });
    expect(setup.acting()[0]).toEqual({
      tool: "cosign",
      args: [
        "verify",
        "--certificate-oidc-issuer",
        TEST_ISSUER,
        "--certificate-identity-regexp",
        expect.stringContaining("example-org/example-worker"),
        "--output",
        "json",
        PINNED_IMAGE,
      ],
    });
    const acting = setup.acting();
    const pull = acting.findIndex((call) => call.tool === "docker" && call.args[0] === "pull");
    expect(pull).toBeGreaterThan(0);
    expect(acting[pull]!.args).toEqual(["pull", PINNED_IMAGE]);
    // Nothing ran before the signature verified: cosign is the first and only tool before the pull.
    expect(acting.slice(0, pull).every((call) => call.tool === "cosign")).toBe(true);
    expect(setup.docker.images).toEqual(new Set([PINNED_IMAGE]));
    expect(setup.docker.volumes).toEqual(new Set([VOLUME_NAME]));
    // Installing runs no container.
    expect(setup.docker.containers.size).toBe(0);

    const record = data(setup.ctx);
    expect(record).toMatchObject({
      form: "container",
      version: "1.0.0",
      artifact: IMAGE_REFERENCE,
      digest: IMAGE_DIGEST,
      identity: { issuer: TEST_ISSUER, subject: TEST_SUBJECT },
      location: CONTAINER_NAME,
      volume: VOLUME_NAME,
      file: null,
      installed: true,
    });
    const stored: Record<string, unknown> = { ...record };
    delete stored["installed"];
    expect(await readRecord(setup.pidgenHome)).toEqual(stored);
  });

  it("prints the licence notice and every command to standard error before running it", async () => {
    const setup = await containerContext();

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Ok,
    );
    const stderr = setup.ctx.err.join("");
    expect(stderr).toContain("licensed");
    expect(stderr).toContain(`$ cosign verify --certificate-oidc-issuer ${TEST_ISSUER}`);
    expect(stderr).toContain(`$ docker pull ${PINNED_IMAGE}`);
    expect(stderr.indexOf("$ cosign verify")).toBeLessThan(stderr.indexOf("$ docker pull"));
  });

  it.each([
    ["wrong-identity", "identity"],
    ["unsigned", "attestation"],
  ] as const)(
    "refuses an image whose signature check fails (%s) and pulls or runs nothing",
    async (answer, check) => {
      const setup = await containerContext({ cosign: answer });

      expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
        ExitCode.Refused,
      );
      expect(envelope(setup.ctx)).toMatchObject({
        ok: false,
        error: { code: "PROVENANCE_INVALID", details: { check } },
      });
      expect(setup.dockerCalls()).toEqual([]);
      expect(await hasRecord(setup.pidgenHome)).toBe(false);
    },
  );

  it("refuses with the release identity the CLI carries when no test identity is injected", async () => {
    const setup = await containerContext({
      cosign: "wrong-identity",
      trust: testTrust(WORKER_RELEASE_IDENTITIES),
    });

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Refused,
    );
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "PROVENANCE_INVALID" } });
    const cosign = setup.log.find((call) => call.tool === "cosign")!;
    expect(cosign.args).toContain(WORKER_RELEASE_IDENTITIES[0]!.issuer);
    expect(setup.dockerCalls()).toEqual([]);
  });

  it("refuses a release whose image reference pins another digest than its tag names, before running anything", async () => {
    const list = releaseList();
    list.releases[0]!.container.reference = `${IMAGE_REFERENCE}@sha256:${"0".repeat(64)}`;
    const setup = await containerContext({ releases: list });

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Refused,
    );
    expect(envelope(setup.ctx)).toMatchObject({
      error: { code: "PROVENANCE_INVALID", details: { check: "digest" } },
    });
    expect(setup.acting()).toEqual([]);
  });

  it("refuses a release list whose series names no image, as not matching the contract", async () => {
    const list = releaseList() as unknown as { releases: Array<Record<string, unknown>> };
    list.releases[0]!["container"] = null;
    const setup = await containerContext({ releases: list as never });

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Unexpected,
    );
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "UNEXPECTED_RESPONSE" } });
    expect(setup.log).toEqual([]);
  });

  it("exits 2 with RUNTIME_UNAVAILABLE and the instructions when docker or cosign is missing", async () => {
    const setup = await containerContext({ tools: false });

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Usage,
    );
    const env = envelope(setup.ctx);
    expect(env).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
    const install = JSON.stringify(
      (env["error"] as { details: Record<string, unknown> }).details["install"],
    );
    expect(install).toContain("docker");
    expect(install).toContain("cosign");
    expect(setup.log).toEqual([]);
  });

  it("reports a failing pull and records nothing", async () => {
    const setup = await containerContext({ docker: { pullFails: true } });

    expect(await runCli(["worker", "install", "--runtime", "container"], setup.ctx)).toBe(
      ExitCode.Unexpected,
    );
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "INSTALL_FAILED" } });
    expect(await hasRecord(setup.pidgenHome)).toBe(false);
  });

  it("chooses the container form when the machine has docker and cosign but no uv", async () => {
    const setup = await containerContext();

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({ form: "container" });
  });

  it("is a no-op for the recorded version, and verifies and pulls again with --force", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "install"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({ form: "container", installed: false });
    expect(setup.log).toEqual([]);

    setup.ctx.out.length = 0;
    expect(await runCli(["worker", "install", "--force"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({ form: "container", installed: true });
    expect(
      setup
        .acting()
        .map((call) => `${call.tool} ${call.args[0]}`)
        .slice(0, 2),
    ).toEqual(["cosign verify", "docker pull"]);
  });
});

describe("imageRepository", () => {
  it.each([
    ["registry.example.com/example-org/worker:1.0.0", "registry.example.com/example-org/worker"],
    ["registry.example.com/example-org/worker", "registry.example.com/example-org/worker"],
    ["localhost:5000/example-org/worker:1.0.0", "localhost:5000/example-org/worker"],
    [`registry.example.com/example-org/worker:1.0.0@${IMAGE_DIGEST}`, IMAGE_REFERENCE],
  ])("%s is %s", (reference, repository) => {
    expect(imageRepository(reference, IMAGE_DIGEST)).toBe(repository);
  });
});

describe("pidgen worker verify (container)", () => {
  it("re-checks that the pinned image is present and its signature still verifies", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "verify"], setup.ctx)).toBe(ExitCode.Ok);
    const checks = data(setup.ctx)["checks"] as Array<Record<string, unknown>>;
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ["digest", "ok"],
      ["provenance", "ok"],
    ]);
    expect(setup.log.map((call) => call.tool)).toContain("cosign");
    expect(setup.dockerCalls().every((args) => args[0] === "image")).toBe(true);
  });

  it("exits 5 with PROVENANCE_INVALID when the image is gone or no longer verifies", async () => {
    const setup = await installed();
    setup.docker.images.clear();
    setup.ctx.cosign = (await containerContext({ cosign: "wrong-identity" })).ctx.cosign;

    expect(await runCli(["worker", "verify"], setup.ctx)).toBe(ExitCode.Refused);
    const env = envelope(setup.ctx);
    expect(env).toMatchObject({ error: { code: "PROVENANCE_INVALID" } });
    const checks = (env["error"] as { details: { checks: Array<Record<string, unknown>> } }).details
      .checks;
    expect(checks.map((check) => [check.id, check.status, check.fix])).toEqual([
      ["digest", "fail", "pidgen worker install --force"],
      ["provenance", "fail", "pidgen worker install --force"],
    ]);
  });
});

describe("pidgen worker start/stop/status/doctor with a container install", () => {
  // AC-29b2fdb6e5fc: a named container with a volume for the worker home; the install record's
  // form selects the adapter, so no pidgen-worker is needed on PATH.
  it("start --detach runs a named container with a volume for the worker home", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "start", "--detach", "--", "--label", "a b"], setup.ctx)).toBe(
      ExitCode.Ok,
    );
    expect(setup.dockerCalls()).toContainEqual([
      "run",
      "--detach",
      "--name",
      CONTAINER_NAME,
      "--volume",
      `${VOLUME_NAME}:/pidgen`,
      "--env",
      "PIDGEN_HOME=/pidgen",
      "--label",
      'ai.pidgen.worker.args=["--label","a b"]',
      PINNED_IMAGE,
      "--label",
      "a b",
    ]);
    expect(setup.docker.containers.get(CONTAINER_NAME)).toMatchObject({
      image: PINNED_IMAGE,
      running: true,
    });
    expect(data(setup.ctx)).toMatchObject({
      running: true,
      record: {
        container: CONTAINER_NAME,
        image: PINNED_IMAGE,
        volume: VOLUME_NAME,
        status: "running",
        started_at: expect.any(String),
        args: ["--label", "a b"],
      },
    });
  });

  it("start --detach refuses while the container runs, and replaces a stopped one", async () => {
    const setup = await installed();
    expect(await runCli(["worker", "start", "--detach"], setup.ctx)).toBe(ExitCode.Ok);
    setup.ctx.out.length = 0;

    expect(await runCli(["worker", "start", "--detach"], setup.ctx)).toBe(ExitCode.Refused);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "WORKER_ALREADY_RUNNING" } });

    setup.docker.containers.get(CONTAINER_NAME)!.running = false;
    setup.ctx.out.length = 0;
    setup.log.length = 0;
    expect(await runCli(["worker", "start", "--detach"], setup.ctx)).toBe(ExitCode.Ok);
    expect(setup.dockerCalls().map((args) => args[0])).toEqual(
      expect.arrayContaining(["rm", "run"]),
    );
  });

  it("start --detach exits 1 with WORKER_EXITED and the container's log when it stops at once", async () => {
    const setup = await installed({ docker: { exitsOnStart: true } });

    expect(await runCli(["worker", "start", "--detach"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      error: {
        code: "WORKER_EXITED",
        details: { log_tail: ["worker: starting", "worker: no credential; enroll first"] },
      },
    });
  });

  it("start in the foreground hands over to docker run --rm and passes its exit status", async () => {
    const setup = await installed({ docker: { foregroundExit: 23 } });

    expect(await runCli(["worker", "start", "--", "--once"], setup.ctx)).toBe(23);
    expect(setup.ctx.out).toEqual([]);
    expect(setup.log.at(-1)).toEqual({
      tool: "docker",
      mode: "foreground",
      args: [
        "run",
        "--rm",
        "--interactive",
        "--name",
        CONTAINER_NAME,
        "--volume",
        `${VOLUME_NAME}:/pidgen`,
        "--env",
        "PIDGEN_HOME=/pidgen",
        "--label",
        'ai.pidgen.worker.args=["--once"]',
        PINNED_IMAGE,
        "--once",
      ],
    });
  });

  it("status reports the container and whether it runs; nothing when there is no container", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "status"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({
      record: null,
      running: false,
      update: { installed: "1.0.0" },
    });

    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.ctx.out.length = 0;
    expect(await runCli(["worker", "status"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({
      running: true,
      record: { container: CONTAINER_NAME, image: PINNED_IMAGE, status: "running" },
    });
    expect(setup.dockerCalls()).toContainEqual(["inspect", "--type", "container", CONTAINER_NAME]);
  });

  it("status exits 2 with RUNTIME_UNAVAILABLE when the Docker daemon cannot be reached", async () => {
    const setup = await installed();
    setup.ctx.docker = (await containerContext({ docker: { daemonDown: true } })).ctx.docker;

    expect(await runCli(["worker", "status"], setup.ctx)).toBe(ExitCode.Usage);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
  });

  it("stop sends SIGTERM to the container and removes it", async () => {
    const setup = await installed();
    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.ctx.out.length = 0;
    setup.log.length = 0;

    expect(await runCli(["worker", "stop"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({
      forced: false,
      record: { container: CONTAINER_NAME },
    });
    expect(setup.dockerCalls()).toContainEqual(["kill", "--signal", "SIGTERM", CONTAINER_NAME]);
    expect(setup.dockerCalls()).toContainEqual(["rm", CONTAINER_NAME]);
    expect(setup.docker.containers.size).toBe(0);
    // The worker home survives in its volume.
    expect(setup.docker.volumes).toContain(VOLUME_NAME);
  });

  it("stop exits 4 with WORKER_NOT_RUNNING when no container runs", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "stop"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "WORKER_NOT_RUNNING" } });
  });

  it("stop times out without --force and kills the container with it", async () => {
    const setup = await installed({ docker: { ignoresSigterm: true } });
    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.ctx.out.length = 0;

    expect(await runCli(["--timeout", "1", "worker", "stop"], setup.ctx)).toBe(ExitCode.Network);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(setup.docker.containers.get(CONTAINER_NAME)?.running).toBe(true);

    setup.ctx.out.length = 0;
    expect(await runCli(["--timeout", "1", "worker", "stop", "--force"], setup.ctx)).toBe(
      ExitCode.Ok,
    );
    expect(data(setup.ctx)).toMatchObject({ forced: true });
    expect(setup.dockerCalls()).toContainEqual(["kill", CONTAINER_NAME]);
    expect(setup.docker.containers.size).toBe(0);
  });

  it("doctor runs docker exec … pidgen-worker doctor --json in the container", async () => {
    const setup = await installed();
    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.ctx.out.length = 0;

    expect(await runCli(["worker", "doctor", "--", "--verbose"], setup.ctx)).toBe(ExitCode.Ok);
    expect(setup.dockerCalls()).toContainEqual([
      "exec",
      CONTAINER_NAME,
      "pidgen-worker",
      "doctor",
      "--json",
      "--verbose",
    ]);
    expect(data(setup.ctx)).toEqual({ healthy: true, args: ["--verbose"] });
  });

  it("doctor exits 1 with DOCTOR_FAILED and the report when a check fails", async () => {
    const report = { healthy: false, checks: [{ name: "credential", ok: false }] };
    const setup = await installed({
      docker: { doctor: { exitCode: 1, stdout: JSON.stringify(report) } },
    });
    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.ctx.out.length = 0;

    expect(await runCli(["worker", "doctor"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      error: { code: "DOCTOR_FAILED", details: report },
    });
  });

  it("doctor exits 4 with WORKER_NOT_RUNNING when the container is not running", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "doctor"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "WORKER_NOT_RUNNING" } });
    expect(setup.dockerCalls().some((args) => args[0] === "exec")).toBe(false);
  });
});

describe("pidgen worker uninstall (container)", () => {
  it("stops a running container first, then removes it, the image and the install record", async () => {
    const setup = await installed();
    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.ctx.out.length = 0;
    setup.log.length = 0;

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.Ok);
    const calls = setup.dockerCalls().map((args) => args.slice(0, 2).join(" "));
    expect(calls.indexOf("kill --signal")).toBeLessThan(calls.indexOf("image rm"));
    expect(setup.docker.containers.size).toBe(0);
    expect(setup.docker.images.size).toBe(0);
    expect(await hasRecord(setup.pidgenHome)).toBe(false);
    expect(data(setup.ctx)).toMatchObject({
      uninstalled: { form: "container", version: "1.0.0" },
      stopped: { forced: false, record: { container: CONTAINER_NAME } },
      removed: [`image ${PINNED_IMAGE}`],
      purged: false,
    });
  });

  it("removes the container and the image and the install record, and keeps the volume", async () => {
    const setup = await installed();
    await runCli(["worker", "start", "--detach"], setup.ctx);
    setup.docker.containers.get(CONTAINER_NAME)!.running = false;
    setup.ctx.out.length = 0;

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.Ok);
    expect(setup.dockerCalls()).toContainEqual(["rm", CONTAINER_NAME]);
    expect(setup.dockerCalls()).toContainEqual(["image", "rm", PINNED_IMAGE]);
    expect(setup.docker.containers.size).toBe(0);
    expect(setup.docker.images.size).toBe(0);
    expect(setup.docker.volumes).toContain(VOLUME_NAME);
    expect(await hasRecord(setup.pidgenHome)).toBe(false);
    expect(data(setup.ctx)).toMatchObject({
      uninstalled: { form: "container", version: "1.0.0" },
      stopped: null,
      purged: false,
      removed: [`container ${CONTAINER_NAME}`, `image ${PINNED_IMAGE}`],
    });
  });

  it("removes the worker home volume with --purge", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "uninstall", "--purge"], setup.ctx)).toBe(ExitCode.Ok);
    expect(setup.dockerCalls()).toContainEqual(["volume", "rm", VOLUME_NAME]);
    expect(setup.docker.volumes.size).toBe(0);
    expect(data(setup.ctx)).toMatchObject({
      purged: true,
      removed: [`image ${PINNED_IMAGE}`, `volume ${VOLUME_NAME}`],
      worker_home: setup.pidgenHome,
    });
    expect(await hasRecord(setup.pidgenHome)).toBe(false);
  });

  it("exits 4 with WORKER_NOT_INSTALLED with no install record, and 2 for an extra argument", async () => {
    const setup = await containerContext();

    expect(await runCli(["worker", "uninstall"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "WORKER_NOT_INSTALLED" } });
    setup.ctx.out.length = 0;
    expect(await runCli(["worker", "uninstall", "extra"], setup.ctx)).toBe(ExitCode.Usage);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "CLI_USAGE" } });
    expect(setup.log).toEqual([]);
  });
});

describe("pidgen worker update (container)", () => {
  it("is a no-op when the recorded release is current", async () => {
    const setup = await installed();

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({ form: "container", version: "1.0.0", updated: false });
    // Nothing is verified, pulled or run: only the container is inspected for `running`.
    expect(setup.log.every((call) => call.tool === "docker" && call.args[0] === "inspect")).toBe(
      true,
    );
  });

  it("verifies and pulls the server's current release for the recorded form", async () => {
    const setup = await installed();
    const record = await readRecord(setup.pidgenHome);
    await writeFile(
      join(setup.pidgenHome, "run", "pidgen-install.json"),
      JSON.stringify({ ...record, version: "0.9.0" }),
    );

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({
      form: "container",
      version: "1.0.0",
      previous_version: "0.9.0",
      updated: true,
    });
    expect(
      setup
        .acting()
        .map((call) => `${call.tool} ${call.args[0]}`)
        .slice(0, 2),
    ).toEqual(["cosign verify", "docker pull"]);
    expect(await readRecord(setup.pidgenHome)).toMatchObject({ version: "1.0.0" });
  });

  /** A container started with `--label alpha`, then an install record one version behind. */
  async function runningBehind(options: ContainerContextOptions = {}) {
    const setup = await installed(options);
    expect(await runCli(["worker", "start", "--detach", "--", "--label", "alpha"], setup.ctx)).toBe(
      ExitCode.Ok,
    );
    const record = await readRecord(setup.pidgenHome);
    await writeFile(
      join(setup.pidgenHome, "run", "pidgen-install.json"),
      JSON.stringify({ ...record, version: "0.9.0" }),
    );
    setup.ctx.out.length = 0;
    setup.log.length = 0;
    return setup;
  }

  it("leaves a running container on the old version without --restart", async () => {
    const setup = await runningBehind();
    const id = setup.docker.containers.get(CONTAINER_NAME)!.id;

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.Ok);
    expect(data(setup.ctx)).toMatchObject({ updated: true, running: true, restarted: false });
    expect(setup.docker.containers.get(CONTAINER_NAME)!.id).toBe(id);
    expect(setup.dockerCalls().some((args) => args[0] === "kill")).toBe(false);
  });

  it("with --restart stops the container after the install and runs it again with the same arguments", async () => {
    const setup = await runningBehind();

    expect(await runCli(["worker", "update", "--restart"], setup.ctx)).toBe(ExitCode.Ok);
    const steps = setup.acting().map((call) => `${call.tool} ${call.args[0]}`);
    expect(steps.indexOf("docker pull")).toBeLessThan(steps.indexOf("docker kill"));
    expect(steps.indexOf("docker kill")).toBeLessThan(steps.lastIndexOf("docker run"));
    const run = setup.dockerCalls().find((args) => args[0] === "run")!;
    expect(run.slice(run.indexOf(PINNED_IMAGE))).toEqual([PINNED_IMAGE, "--label", "alpha"]);
    expect(data(setup.ctx)).toMatchObject({
      version: "1.0.0",
      updated: true,
      previous_version: "0.9.0",
      running: true,
      restarted: true,
      worker: { container: CONTAINER_NAME, args: ["--label", "alpha"], status: "running" },
    });
  });

  it("rolls back when the restarted container exits during startup: verifies and pulls the previous image again and restores the record", async () => {
    const dockerOptions: { exitsOnStart?: number } = {};
    const setup = await runningBehind({ docker: dockerOptions });
    dockerOptions.exitsOnStart = 1;

    expect(await runCli(["worker", "update", "--restart"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      ok: false,
      error: {
        code: "UPDATE_ROLLED_BACK",
        details: {
          version: "1.0.0",
          previous_version: "0.9.0",
          cause: "WORKER_EXITED",
          running: true,
          worker: { container: CONTAINER_NAME, args: ["--label", "alpha"] },
        },
      },
    });
    // The previous image is verified again before it is pulled for the rollback.
    const steps = setup.acting().map((call) => `${call.tool} ${call.args[0]}`);
    const after = steps.slice(steps.indexOf("docker logs"));
    expect(after.indexOf("cosign verify")).toBeLessThan(after.indexOf("docker pull"));
    expect(await readRecord(setup.pidgenHome)).toMatchObject({ version: "0.9.0" });
    expect(setup.docker.containers.get(CONTAINER_NAME)?.running).toBe(true);
  });

  it("refuses to roll back onto an image whose signature no longer verifies", async () => {
    const dockerOptions: { exitsOnStart?: number } = {};
    const setup = await runningBehind({ docker: dockerOptions });
    dockerOptions.exitsOnStart = 1;
    const verified = setup.ctx.cosign;
    let calls = 0;
    setup.ctx.cosign = {
      run: (args) => (++calls === 1 ? verified.run(args) : fakeCosign([], "unsigned").run(args)),
    };

    expect(await runCli(["worker", "update", "--restart"], setup.ctx)).toBe(ExitCode.Unexpected);
    expect(envelope(setup.ctx)).toMatchObject({
      error: { code: "ROLLBACK_FAILED", details: { rollback: { code: "PROVENANCE_INVALID" } } },
    });
    expect(setup.dockerCalls().filter((args) => args[0] === "pull")).toHaveLength(1);
  });

  it("exits 4 with WORKER_NOT_INSTALLED with no install record", async () => {
    const setup = await containerContext();

    expect(await runCli(["worker", "update"], setup.ctx)).toBe(ExitCode.NotFound);
    expect(envelope(setup.ctx)).toMatchObject({ error: { code: "WORKER_NOT_INSTALLED" } });
  });
});

describe("dockerRunner", () => {
  // AC-e521c9a6ddbd: the real runner is exercised only against a stand-in docker script.
  async function fakeDockerOnPath(): Promise<{ path: string; directory: string }> {
    const directory = await tempDir("pidgen-docker-");
    const bin = join(directory, "bin");
    await mkdir(bin);
    const script = join(bin, "docker");
    await writeFile(
      script,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify(args));\nprocess.stderr.write("note\\n");\nprocess.exit(args[0] === "fail" ? 3 : 0);\n`,
    );
    await chmod(script, 0o755);
    return { path: [bin, "/usr/bin", "/bin"].join(delimiter), directory };
  }

  it("runs docker with an argument list and captures its output and status", async () => {
    const { path, directory } = await fakeDockerOnPath();
    const docker = dockerRunner(
      { env: { PATH: path }, homeDir: directory, cwd: directory },
      defaultWorkerRuntime,
    );

    expect(await docker.run(["inspect", "a b"])).toEqual({
      exitCode: 0,
      stdout: JSON.stringify(["inspect", "a b"]),
      stderr: "note\n",
    });
    expect((await docker.run(["fail"])).exitCode).toBe(3);
  });

  it("reports a missing docker as RUNTIME_UNAVAILABLE", async () => {
    const directory = await tempDir("pidgen-docker-");
    const docker = dockerRunner(
      { env: { PATH: directory }, homeDir: directory, cwd: directory },
      defaultWorkerRuntime,
    );

    await expect(docker.run(["version"])).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      exitCode: ExitCode.Usage,
    });
  });

  it("is never the real docker or cosign in a test context", async () => {
    const ctx = await testContext();
    await expect(ctx.docker.run(["version"])).rejects.toThrow(/unexpected docker call/);
    await expect(ctx.cosign.run(["version"])).rejects.toThrow(/unexpected cosign call/);
  });
});
