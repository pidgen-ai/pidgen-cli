import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { OutputFormat } from "./envelope.js";
import { clackPrompter, type Prompter } from "./prompter.js";
import {
  cosignRunner,
  sigstorePublicGoodTrust,
  type CosignRunner,
  type ProvenanceTrust,
} from "./provenance.js";
import { dockerRunner, type DockerRunner } from "./worker-container.js";
import { defaultWorkerRuntime, type WorkerRuntime } from "./worker.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** True when standard error is a terminal; progress lines are written only then. */
  interactive: boolean;
  /** Standard output's terminal state, independent of progress and setup on stderr. */
  stdoutIsTTY: boolean;
  /** Available output width when stdout is a terminal. */
  stdoutColumns?: number;
  /**
   * When true, the commands the CLI runs have their output piped and written to `stderr()`, line
   * by line, instead of sharing the CLI's standard error. `pidgen setup` sets it on the context it
   * runs commands with, so their output goes to its log and stays off the screen.
   */
  pipeChildren?: boolean;
}

/**
 * Everything a command may touch outside its arguments. Tests build one with fakes;
 * `defaultContext()` builds the real one.
 */
export interface RunContext {
  env: Record<string, string | undefined>;
  io: Io;
  fetch: typeof fetch;
  homeDir: string;
  cwd: string;
  /** Directory holding the skills bundled with this CLI. */
  bundledSkillsDir: string;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Reads all of standard input as UTF-8: the token for `pidgen auth login --with-token`,
   * or a request body when a command is given `-f -`.
   */
  readStdin(): Promise<string>;
  /** Process operations used to find and run the separately installed worker. */
  workerRuntime: WorkerRuntime;
  /**
   * What a worker artifact's provenance is verified against: the worker's release identities and
   * Sigstore's trust root, cached under `cacheDir`. Tests inject a recorded trust root and a test
   * identity, so they never reach Sigstore.
   */
  provenanceTrust(cacheDir: string): ProvenanceTrust;
  /**
   * Runs `docker` for the container runtime. Tests inject a fake, so they never reach a Docker
   * daemon or a registry.
   */
  docker: DockerRunner;
  /**
   * Runs `cosign`, which verifies the worker image's signature. Tests inject a fake answering with
   * recorded output, so they never reach a registry or Sigstore.
   */
  cosign: CosignRunner;
  /**
   * Opens the prompter that asks a person questions on the terminal (clack's prompts, loaded only
   * when this is called). `null` when standard input or standard error is not a terminal, so a
   * command can never wait on a question nobody can answer. Only `pidgen setup`, the CLI's one
   * interactive command, uses it.
   */
  prompter: (() => Promise<Prompter>) | null;
  /**
   * This machine's host name. `pidgen worker status` looks for the worker with this host id in the
   * App Service's list unless `--host` names another.
   */
  hostName: string;
}

/** Options every command accepts; set from the global flags. */
export interface GlobalOptions {
  profile?: string;
  account?: string;
  format: OutputFormat;
  timeoutSeconds: number;
}

/**
 * Lets whatever reads the CLI's output close it early, as `pidgen … | head -1` does: an `EPIPE` on
 * the stream is ignored, so the command finishes and exits with its own code instead of crashing
 * with a stack trace. Any other error on the stream is thrown as before.
 */
export function ignoreClosedPipe(stream: NodeJS.EventEmitter): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

export function defaultContext(): RunContext {
  const home = homedir();
  return {
    env: process.env,
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      interactive: process.stderr.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
      ...(process.stdout.columns ? { stdoutColumns: process.stdout.columns } : {}),
    },
    fetch: globalThis.fetch,
    homeDir: home,
    cwd: process.cwd(),
    // The bundle is dist/pidgen.js; skills ship beside dist/ in the package.
    bundledSkillsDir: fileURLToPath(new URL("../skills", import.meta.url)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks).toString("utf8");
    },
    workerRuntime: defaultWorkerRuntime,
    provenanceTrust: (cacheDir) => sigstorePublicGoodTrust({ cacheDir }),
    docker: dockerRunner({ env: process.env, homeDir: home, cwd: process.cwd() }),
    cosign: cosignRunner(process.env),
    prompter:
      process.stdin.isTTY === true && process.stderr.isTTY === true
        ? () => clackPrompter({ input: process.stdin, output: process.stderr })
        : null,
    hostName: hostname(),
  };
}
