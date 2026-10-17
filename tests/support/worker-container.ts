import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CosignRunner } from "../../src/core/provenance.js";
import type { DockerResult, DockerRunner } from "../../src/core/worker-container.js";
import { FIXTURES, installContext, type InstallContextOptions } from "./worker-install.js";

/**
 * Fakes for the container runtime: a fake `docker` that keeps images, volumes and containers in
 * memory and answers in the shapes the real one does (tests/fixtures/container/), and a fake
 * `cosign` answering with the recorded verify output (tests/fixtures/provenance/). Both log every
 * argument list to one shared log, so a test can see what ran and in which order. Nothing reaches
 * a registry, a Docker daemon or Sigstore.
 */

export const IMAGE_REFERENCE = "registry.example.com/example-org/worker";
export const IMAGE_DIGEST =
  "sha256:925955a225a5c7e39cfcc41964a065a7945e7c22a1d27d11976ea928e8c0b4c3";
export const PINNED_IMAGE = `${IMAGE_REFERENCE}@${IMAGE_DIGEST}`;
export const CONTAINER_NAME = "pidgen-worker";
export const VOLUME_NAME = "pidgen-worker-home";
const CONTAINER_FIXTURES = join(FIXTURES, "..", "container");

export const recorded = (directory: "provenance" | "container", name: string): string =>
  readFileSync(join(directory === "provenance" ? FIXTURES : CONTAINER_FIXTURES, name), "utf8");

export interface ToolCall {
  tool: "docker" | "cosign";
  args: string[];
  /** For docker: how it was run. */
  mode?: "capture" | "progress" | "foreground";
}

export interface FakeContainer {
  id: string;
  image: string;
  running: boolean;
  args: string[];
  options: string[];
}

export interface FakeDockerOptions {
  /** `docker pull` fails. */
  pullFails?: boolean;
  /**
   * A detached container exits as soon as it starts: every one, or (a number) only that many of
   * the next ones. Read when each container starts, so a test may set it between commands.
   */
  exitsOnStart?: boolean | number;
  /** The container ignores SIGTERM, so only a kill stops it. */
  ignoresSigterm?: boolean;
  /** What `docker exec … doctor --json` prints and exits with. */
  doctor?: { exitCode: number; stdout: string };
  /** The exit status of a foreground `docker run`. */
  foregroundExit?: number;
  /** Every docker command fails as if no daemon were running. */
  daemonDown?: boolean;
}

export interface FakeDocker extends DockerRunner {
  images: Set<string>;
  volumes: Set<string>;
  containers: Map<string, FakeContainer>;
}

const DAEMON_DOWN =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n";

export function fakeDocker(log: ToolCall[], options: FakeDockerOptions = {}): FakeDocker {
  const images = new Set<string>();
  const volumes = new Set<string>();
  const containers = new Map<string, FakeContainer>();
  const ok = (stdout = ""): DockerResult => ({ exitCode: 0, stdout, stderr: "" });
  const fail = (stderr: string, exitCode = 1): DockerResult => ({ exitCode, stdout: "", stderr });

  /** Splits `docker run` arguments into its options, the container name, the image and its args. */
  const parseRun = (args: string[]) => {
    const runOptions: string[] = [];
    let index = 1;
    let name = "";
    while (index < args.length && args[index]!.startsWith("--")) {
      const flag = args[index]!;
      if (flag === "--detach" || flag === "--rm" || flag === "--init" || flag === "--interactive") {
        runOptions.push(flag);
        index += 1;
        continue;
      }
      const value = args[index + 1]!;
      if (flag === "--name") name = value;
      runOptions.push(flag, value);
      index += 2;
    }
    return { name, options: runOptions, image: args[index]!, args: args.slice(index + 1) };
  };

  const inspect = (name: string): DockerResult => {
    const container = containers.get(name);
    if (container === undefined) return fail(`Error: No such container: ${name}\n`);
    const [template] = JSON.parse(recorded("container", "docker-inspect.json")) as [
      Record<string, Record<string, unknown>>,
    ];
    template["Id"] = container.id as never;
    template["Name"] = `/${name}` as never;
    template["State"]!["Running"] = container.running;
    template["State"]!["Status"] = container.running ? "running" : "exited";
    template["Config"]!["Image"] = container.image;
    const labels: Record<string, string> = {};
    container.options.forEach((option, index) => {
      if (option !== "--label") return;
      const label = container.options[index + 1]!;
      const equals = label.indexOf("=");
      labels[label.slice(0, equals)] = label.slice(equals + 1);
    });
    template["Config"]!["Labels"] = labels;
    return ok(JSON.stringify([template]));
  };

  const run = async (args: string[]): Promise<DockerResult> => {
    if (options.daemonDown) return fail(DAEMON_DOWN);
    const [command, ...rest] = args;
    switch (command) {
      case "buildx": {
        // `buildx imagetools inspect <repository>:<tag> --format {{json .Manifest}}`: what the tag
        // points at now. Every tag resolves to the recorded image's digest.
        if (rest[0] !== "imagetools" || rest[1] !== "inspect") return fail("unknown buildx call\n");
        return ok(
          JSON.stringify({
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: IMAGE_DIGEST,
          }),
        );
      }
      case "pull": {
        if (options.pullFails) return fail("Error response from daemon: manifest unknown\n");
        images.add(rest.at(-1)!);
        return ok();
      }
      case "volume": {
        const [verb, name] = rest as [string, string];
        if (verb === "create") {
          volumes.add(name);
          return ok(`${name}\n`);
        }
        if (verb === "rm") {
          if (!volumes.delete(name)) {
            return fail(`Error response from daemon: get ${name}: no such volume\n`);
          }
          return ok(`${name}\n`);
        }
        break;
      }
      case "image": {
        const [verb] = rest;
        const reference = rest.at(-1)!;
        if (verb === "inspect") {
          if (!images.has(reference)) return fail(`Error: No such image: ${reference}\n`);
          return ok(`${JSON.stringify([reference])}\n`);
        }
        if (verb === "rm") {
          if (!images.delete(reference)) {
            return fail(`Error response from daemon: No such image: ${reference}\n`);
          }
          return ok(`Untagged: ${reference}\n`);
        }
        break;
      }
      case "inspect":
        return inspect(rest.at(-1)!);
      case "run": {
        const parsed = parseRun(args);
        if (containers.has(parsed.name)) {
          return fail(
            `docker: Error response from daemon: Conflict. The container name "/${parsed.name}" is already in use.\n`,
            125,
          );
        }
        if (!images.has(parsed.image)) return fail(`Unable to find image '${parsed.image}'\n`, 125);
        const id = `${parsed.name}-${containers.size + 1}`.padEnd(64, "0");
        let exits = options.exitsOnStart === true;
        if (typeof options.exitsOnStart === "number" && options.exitsOnStart > 0) {
          options.exitsOnStart -= 1;
          exits = true;
        }
        containers.set(parsed.name, {
          id,
          image: parsed.image,
          running: !exits,
          args: parsed.args,
          options: parsed.options,
        });
        return ok(`${id}\n`);
      }
      case "kill": {
        const name = rest.at(-1)!;
        const container = containers.get(name);
        if (container === undefined || !container.running) {
          return fail(`Error response from daemon: container ${name} is not running\n`);
        }
        const signal = rest[0] === "--signal" ? rest[1] : "SIGKILL";
        if (signal === "SIGKILL" || !options.ignoresSigterm) container.running = false;
        return ok(`${name}\n`);
      }
      case "rm": {
        const name = rest.at(-1)!;
        const container = containers.get(name);
        if (container === undefined) return fail(`Error: No such container: ${name}\n`);
        if (container.running && !rest.includes("--force")) {
          return fail(`Error response from daemon: cannot remove container "/${name}"\n`);
        }
        containers.delete(name);
        return ok(`${name}\n`);
      }
      case "logs":
        return ok("worker: starting\nworker: no credential; enroll first\n");
      case "exec": {
        const name = rest[0]!;
        const container = containers.get(name);
        if (container === undefined || !container.running) {
          return fail(`Error response from daemon: container ${name} is not running\n`);
        }
        const doctor = options.doctor ?? {
          exitCode: 0,
          stdout: JSON.stringify({ healthy: true, args: rest.slice(4) }),
        };
        return { exitCode: doctor.exitCode, stdout: doctor.stdout, stderr: "" };
      }
    }
    return fail(`fake docker: unexpected command ${args.join(" ")}\n`, 2);
  };

  return {
    images,
    volumes,
    containers,
    async run(args, runOptions) {
      log.push({
        tool: "docker",
        args: [...args],
        mode: runOptions?.progress ? "progress" : "capture",
      });
      return run([...args]);
    },
    async foreground(args) {
      log.push({ tool: "docker", args: [...args], mode: "foreground" });
      if (options.daemonDown) return 125;
      const parsed = parseRun([...args]);
      if (!images.has(parsed.image)) return 125;
      return options.foregroundExit ?? 0;
    },
  };
}

export type CosignAnswer = "verified" | "wrong-identity" | "unsigned";

export function fakeCosign(log: ToolCall[], answer: CosignAnswer = "verified"): CosignRunner {
  return {
    async run(args) {
      log.push({ tool: "cosign", args: [...args] });
      if (answer === "verified") {
        return { exitCode: 0, stdout: recorded("provenance", "cosign-verify.json"), stderr: "" };
      }
      const stderr = recorded(
        "provenance",
        answer === "unsigned"
          ? "cosign-verify-unsigned.stderr"
          : "cosign-verify-wrong-identity.stderr",
      );
      return { exitCode: 1, stdout: "", stderr };
    },
  };
}

export interface ContainerContextOptions extends InstallContextOptions {
  docker?: FakeDockerOptions;
  cosign?: CosignAnswer;
  /** Put trivial `docker` and `cosign` executables on PATH (default true). */
  tools?: boolean;
}

/**
 * An install context for the container runtime: no `uv`, `docker` and `cosign` on PATH (never
 * run: the fakes answer), and the fake runners injected into the context.
 */
export async function containerContext(options: ContainerContextOptions = {}) {
  const log: ToolCall[] = [];
  const docker = fakeDocker(log, options.docker);
  const cosign = fakeCosign(log, options.cosign);
  const setup = await installContext({
    uv: false,
    ...options,
    commands: [
      ...(options.tools === false ? [] : ["docker", "cosign"]),
      ...(options.commands ?? []),
    ],
  });
  setup.ctx.docker = docker;
  setup.ctx.cosign = cosign;
  return {
    ...setup,
    docker,
    log,
    /** The docker calls that change something: the read-only tag lookup is left out. */
    dockerCalls: () =>
      log
        .filter((call) => call.tool === "docker" && !isTagLookup(call.args))
        .map((call) => call.args),
    /** Every tool call but the read-only tag lookup, in order. */
    acting: () => log.filter((call) => !(call.tool === "docker" && isTagLookup(call.args))),
  };
}

/** `docker buildx imagetools inspect …`: resolving a tag to its digest, which changes nothing. */
export function isTagLookup(args: readonly string[]): boolean {
  return args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect";
}
