import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

/**
 * Runs Prism (`@stoplight/prism-cli`) in mock mode for an OpenAPI document, on a free loopback
 * port, so contract tests can drive the real HTTP client against the documented responses.
 * See CONTRIBUTING.md → Tests.
 */

/** The committed public API document, `contracts/openapi.json`: the default the mock serves. */
export const COMMITTED_DOCUMENT = fileURLToPath(
  new URL("../../contracts/openapi.json", import.meta.url),
);

/**
 * The committed document prepared for Prism's static mock, written to a temporary file; returns
 * its path. Two things change, neither a validation keyword, so the paths, parameters and schemas
 * the requests and answers are checked against are the committed ones:
 *
 * - Every string `default` shorter than its own `minLength` is dropped. The static mock answers a
 *   property with its `default`, and the published Ticket schemas declare `title` and `objective`
 *   with `minLength: 1` and `default: ""`, so the mock would answer a Ticket its schema refuses.
 * - `examples` (`"GET /api/v1/…"` to a whole response body) become the `example` of that route's
 *   2xx JSON answer, for a test that needs particular values where the document states none. The
 *   caller checks each against the published schema.
 */
export function committedDocumentForStaticMock(examples: Record<string, unknown> = {}): string {
  const document = JSON.parse(readFileSync(COMMITTED_DOCUMENT, "utf8")) as {
    paths: Record<string, Record<string, { responses: Record<string, Record<string, unknown>> }>>;
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      const schema = value as Record<string, unknown>;
      if (
        typeof schema["default"] === "string" &&
        typeof schema["minLength"] === "number" &&
        schema["default"].length < schema["minLength"]
      ) {
        delete schema["default"];
      }
      Object.values(schema).forEach(walk);
    }
  };
  walk(document);
  for (const [route, example] of Object.entries(examples)) {
    const [method, path] = route.split(" ") as [string, string];
    const responses = document.paths[path]?.[method.toLowerCase()]?.responses ?? {};
    const success = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))?.[1];
    const json = (success?.["content"] as Record<string, Record<string, unknown>> | undefined)?.[
      "application/json"
    ];
    if (json === undefined) throw new Error(`${route} has no 2xx JSON answer in the document`);
    json["example"] = example;
  }
  const file = join(mkdtempSync(join(tmpdir(), "pidgen-mock-")), "openapi.json");
  writeFileSync(file, JSON.stringify(document));
  return file;
}

/**
 * A small representative document with response examples. Use it only where a test needs a shape
 * the committed document lacks: a specific error code, or an apply that settles only after polling.
 */
export const FIXTURE_DOCUMENT = fileURLToPath(
  new URL("../fixtures/openapi.fixture.json", import.meta.url),
);

export interface MockServer {
  /** Origin to use as the client's base URL, e.g. `http://127.0.0.1:43127`. */
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  /** True once the Prism process has exited. */
  readonly stopped: boolean;
  /** Stops Prism and waits for the process to exit. Safe to call more than once. */
  stop(): Promise<void>;
}

export interface MockServerOptions {
  /** How long to wait for Prism to report that it is listening. */
  startTimeoutMs?: number;
  /** How long to wait for Prism to exit after SIGTERM before killing it. */
  stopTimeoutMs?: number;
}

const HOST = "127.0.0.1";
const running = new Set<ChildProcess>();

// Never leave a Prism process behind, even when a test run is interrupted.
process.once("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

function prismBin(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@stoplight/prism-cli/package.json");
  const manifest = require(manifestPath) as { bin: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin["prism"];
  if (bin === undefined) throw new Error("@stoplight/prism-cli does not declare a prism bin");
  return join(dirname(manifestPath), bin);
}

/** A loopback port that was free a moment ago. */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Starts Prism in mock mode for `document` and resolves once it is listening. */
export async function startMockServer(
  document: string = COMMITTED_DOCUMENT,
  options: MockServerOptions = {},
): Promise<MockServer> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [prismBin(), "mock", "--host", HOST, "--port", String(port), resolve(document)],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
  );
  running.add(child);

  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      running.delete(child);
      resolveExit();
    });
  });
  let hasExited = false;
  void exited.then(() => {
    hasExited = true;
  });

  const stop = async (): Promise<void> => {
    if (hasExited) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), options.stopTimeoutMs ?? 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await waitUntilListening(child, exited, options.startTimeoutMs ?? 30_000);
  } catch (error) {
    await stop();
    throw error;
  }

  if (child.pid === undefined) throw new Error("Prism started without a process id");
  const pid = child.pid;
  return {
    url: `http://${HOST}:${port}`,
    port,
    pid,
    get stopped() {
      return hasExited;
    },
    stop,
  };
}

function waitUntilListening(
  child: ChildProcess,
  exited: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("Prism is listening")) finish();
    };
    const timer = setTimeout(
      () => finish(new Error(`Prism did not start within ${timeoutMs} ms:\n${output}`)),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      // Keep draining output so Prism never blocks on a full pipe.
      child.stdout?.resume();
      child.stderr?.resume();
      if (error) reject(error);
      else resolveReady();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    void exited.then(() =>
      finish(
        new Error(`Prism exited before it was listening (code ${child.exitCode}):\n${output}`),
      ),
    );
  });
}

export interface LifecycleHooks {
  beforeAll(fn: () => Promise<void>, timeout?: number): void;
  afterAll(fn: () => Promise<void>, timeout?: number): void;
}

/**
 * Starts a mock server before the tests of the enclosing suite and stops it after them.
 * Returns an accessor for the running server.
 */
export function useMockServer(
  document: string = COMMITTED_DOCUMENT,
  options: MockServerOptions = {},
  hooks: LifecycleHooks = { beforeAll, afterAll },
): () => MockServer {
  let server: MockServer | undefined;
  const startTimeout = (options.startTimeoutMs ?? 30_000) + 5000;
  hooks.beforeAll(async () => {
    server = await startMockServer(document, options);
  }, startTimeout);
  hooks.afterAll(
    async () => {
      await server?.stop();
    },
    (options.stopTimeoutMs ?? 5000) + 5000,
  );
  return () => {
    if (server === undefined) throw new Error("The mock server is not running");
    return server;
  };
}
