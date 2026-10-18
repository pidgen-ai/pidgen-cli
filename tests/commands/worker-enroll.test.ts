import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { saveConfig, type Config } from "../../src/core/config.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import type { Prompter } from "../../src/core/prompter.js";
import { defaultWorkerRuntime } from "../../src/core/worker.js";
import {
  envelope,
  jsonResponse,
  tempDir,
  testContext,
  type TestContext,
} from "../support/context.js";
import {
  fixture,
  installContext,
  RELEASES_URL,
  WHEEL,
  WHEEL_SHA256,
  type InstallContextOptions,
} from "../support/worker-install.js";

const SERVER = "https://pidgen.example.com";
const PAT = "pidgen_pat_fake_token_for_tests";
const ENROLL_TOKEN = "pidgen_enroll_fake_one_time_token";
const NODE_TOKEN = "pidgen_node_fake_node_token";

interface Body {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  meta: Record<string, unknown>;
}

interface Call {
  url: URL;
  method: string;
  body: unknown;
}

interface WorkerCall {
  args: string[];
  pidgen_home: string;
  pidgen_token: string | null;
}

const CONFIG: Config = {
  default_profile: "default",
  profiles: {
    default: {
      url: SERVER,
      default_account: "ACC-EXAMPLE",
      credentials: { "ACC-EXAMPLE": { kind: "pat", token: PAT } },
    },
  },
};

/**
 * A stand-in for `pidgen-worker`: `enroll` records its arguments outside the CLI's home, stores a
 * credential under PIDGEN_HOME as the real worker does, and exits with FAKE_WORKER_EXIT.
 */
const WORKER_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_WORKER_RECORD, JSON.stringify({
  args,
  pidgen_home: process.env.PIDGEN_HOME,
  pidgen_token: process.env.PIDGEN_TOKEN ?? null,
}));
if (args[0] === "enroll") {
  fs.mkdirSync(process.env.PIDGEN_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.PIDGEN_HOME, "node-credential"), ${JSON.stringify(NODE_TOKEN)});
}
process.exit(Number(process.env.FAKE_WORKER_EXIT ?? "0"));
`;

function enrollment(installCommand: string) {
  return {
    enrollment_id: "enr-example-1",
    account_id: "ACC-EXAMPLE",
    label: null,
    fingerprint: "abc123",
    created_by: "user-example",
    created_at: "2026-09-27T10:00:00Z",
    expires_at: "2026-09-28T10:00:00Z",
    consumed_at: null,
    consumed_host_id: null,
    revoked_at: null,
    state: "pending",
    token: ENROLL_TOKEN,
    install_commands: {
      container: `docker run -e PIDGEN_ENROLL_TOKEN=${ENROLL_TOKEN} example/pidgen-worker:1.0`,
      wheel: `${installCommand} && pidgen-worker enroll --token ${ENROLL_TOKEN}`,
    },
    install: [
      {
        form: "container",
        artifact: "example/pidgen-worker:1.0",
        install: "docker pull example/pidgen-worker:1.0",
        enroll: `docker run -e PIDGEN_ENROLL_TOKEN=${ENROLL_TOKEN} example/pidgen-worker:1.0`,
        command: `docker pull example/pidgen-worker:1.0 && docker run -e PIDGEN_ENROLL_TOKEN=${ENROLL_TOKEN} example/pidgen-worker:1.0`,
      },
      {
        form: "wheel",
        artifact: "pidgen-worker~=1.0.0",
        install: installCommand,
        enroll: `pidgen-worker enroll --token ${ENROLL_TOKEN}`,
        command: `${installCommand} && pidgen-worker enroll --token ${ENROLL_TOKEN}`,
      },
    ],
    eula: {
      name: "Pidgen Worker End-User Licence Agreement",
      location: "https://pidgen.example.com/legal/worker-eula",
      notice: "Installing pidgen-worker accepts its end-user licence agreement.",
    },
  };
}

function ok(status: number, data: unknown) {
  return jsonResponse(
    status,
    { status: "ok", data, meta: null },
    { "x-request-id": "req_fake_enroll", "pidgen-api-version": "1.0" },
  );
}

function publicError(status: number, code: string, message: string) {
  return jsonResponse(
    status,
    { status: "error", error: { code, message, details: null, request_id: "req_fake_error" } },
    { "x-request-id": "req_fake_error" },
  );
}

/**
 * A terminal's prompter that `worker enroll` must never open: opening it records a question and
 * fails. `null` is no terminal.
 */
function trapPrompter(
  ask: ((question: string) => Promise<string>) | null | undefined,
  questions: string[],
): (() => Promise<Prompter>) | null {
  if (ask === undefined || ask === null) return null;
  return () => {
    questions.push("worker enroll opened the prompter");
    return Promise.reject(new Error("worker enroll must never ask"));
  };
}

interface Setup {
  /** Put the fake pidgen-worker on PATH before the command runs. */
  installed?: boolean;
  respond?: (call: Call) => Response;
  /** A terminal to ask on; `worker enroll` must never use it. */
  ask?: ((question: string) => Promise<string>) | null;
  env?: Record<string, string>;
}

async function setup(options: Setup = {}) {
  const root = await tempDir("pidgen-worker-enroll-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const source = join(root, "source-pidgen-worker");
  const record = join(root, "worker-call.json");
  const installMarker = join(root, "install-ran");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(source, WORKER_SCRIPT);
  await chmod(source, 0o755);
  if (options.installed) {
    await writeFile(join(bin, "pidgen-worker"), WORKER_SCRIPT);
    await chmod(join(bin, "pidgen-worker"), 0o755);
  }
  const installCommand = `touch '${installMarker}' && cp '${source}' '${bin}/pidgen-worker'`;

  const calls: Call[] = [];
  const respond = options.respond ?? (() => ok(201, enrollment(installCommand)));
  const questions: string[] = [];
  const prompter = trapPrompter(options.ask, questions);
  const ctx = await testContext({
    homeDir: home,
    cwd: home,
    env: {
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      FAKE_WORKER_RECORD: record,
      ...options.env,
    },
    fetch: (input, init) => {
      const text = init?.body;
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body: typeof text === "string" ? (JSON.parse(text) as unknown) : undefined,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
    workerRuntime: defaultWorkerRuntime,
    prompter,
  });
  await saveConfig(ctx, CONFIG);

  return {
    ctx,
    calls,
    questions,
    home,
    bin,
    installCommand,
    installRan: () => exists(installMarker),
    workerCall: async (): Promise<WorkerCall | null> =>
      (await exists(record)) ? (JSON.parse(await readFile(record, "utf8")) as WorkerCall) : null,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(ctx: TestContext, ...argv: string[]) {
  ctx.out.length = 0;
  const code = await runCli(argv, ctx);
  expect(ctx.out).toHaveLength(1);
  return { code, body: envelope(ctx) as unknown as Body };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("pidgen worker enroll", () => {
  it("enroll creates an enrollment and passes it to pidgen-worker enroll", async () => {
    const { ctx, calls, workerCall, installRan, bin, home } = await setup({ installed: true });

    const { code, body } = await run(ctx, "worker", "enroll", "--", "--extra");

    expect(code).toBe(ExitCode.Ok);
    expect(calls.map((call) => [call.method, call.url.href, call.body])).toEqual([
      ["POST", `${SERVER}/api/v1/workers/enrollments`, {}],
    ]);
    expect(await workerCall()).toEqual({
      args: ["enroll", "--token", ENROLL_TOKEN, "--server", SERVER, "--no-start", "--extra"],
      pidgen_home: join(home, ".pidgen"),
      pidgen_token: null,
    });
    expect(await installRan()).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      error: null,
      data: {
        enrolled: true,
        installed: null,
        worker: join(bin, "pidgen-worker"),
        enrollment: {
          enrollment_id: "enr-example-1",
          account_id: "ACC-EXAMPLE",
          state: "pending",
          expires_at: "2026-09-28T10:00:00Z",
        },
        eula: { name: "Pidgen Worker End-User Licence Agreement" },
      },
      meta: { request_id: "req_fake_enroll", account: "ACC-EXAMPLE" },
    });
    expect(body.data?.["install"]).toEqual([
      {
        form: "container",
        artifact: "example/pidgen-worker:1.0",
        install: "docker pull example/pidgen-worker:1.0",
      },
      { form: "wheel", artifact: "pidgen-worker~=1.0.0", install: expect.any(String) },
    ]);
  });

  it("enroll sends --label as the enrollment's label", async () => {
    const { ctx, calls } = await setup({ installed: true });

    const { code } = await run(ctx, "worker", "enroll", "--label", "build box", "--no-install");

    expect(code).toBe(ExitCode.Ok);
    expect(calls[0]?.body).toEqual({ label: "build box" });
  });

  it("enroll refuses a label the public document does not accept, before any request", async () => {
    const { ctx, calls } = await setup({ installed: true });

    const { code, body } = await run(ctx, "worker", "enroll", "--label", "x".repeat(101));

    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(calls).toEqual([]);
  });

  it("no-install: with pidgen-worker installed enrolls without installing", async () => {
    const { ctx, installRan, workerCall } = await setup({ installed: true });

    const { code } = await run(ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Ok);
    expect(await installRan()).toBe(false);
    expect((await workerCall())?.args).toEqual([
      "enroll",
      "--token",
      ENROLL_TOKEN,
      "--server",
      SERVER,
      "--no-start",
    ]);
  });

  it("token: a failed pidgen-worker enroll reports ENROLL_FAILED without the token", async () => {
    const { ctx } = await setup({ installed: true, env: { FAKE_WORKER_EXIT: "9" } });

    const { code, body } = await run(ctx, "worker", "enroll");

    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "ENROLL_FAILED", details: { exit_code: 9 } },
    });
    expect(ctx.out.join("")).not.toContain(ENROLL_TOKEN);
  });

  it("token: pidgen-worker never receives the person's PIDGEN_TOKEN", async () => {
    const { ctx, workerCall, calls } = await setup({
      installed: true,
      env: { PIDGEN_API_URL: SERVER, PIDGEN_TOKEN: PAT, PIDGEN_ACCOUNT: "ACC-EXAMPLE" },
    });

    const { code } = await run(ctx, "worker", "enroll");

    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect((await workerCall())?.pidgen_token).toBeNull();
  });

  it("forbidden: a caller who may not enroll workers exits 3", async () => {
    const { ctx, workerCall, installRan } = await setup({
      installed: true,
      respond: () => publicError(403, "FORBIDDEN", "You may not enroll workers."),
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "FORBIDDEN", details: { status: 403, request_id: "req_fake_error" } },
    });
    expect(await workerCall()).toBeNull();
    expect(await installRan()).toBe(false);
  });

  it("enroll refuses an unsupported platform before creating an enrollment", async () => {
    const { ctx, calls } = await setup({ installed: true });
    ctx.workerRuntime = { ...defaultWorkerRuntime, platform: "win32" };

    const { code, body } = await run(ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PLATFORM" } });
    expect(calls).toEqual([]);
  });
});

interface MissingOptions {
  /** A terminal to ask on; `worker enroll` must never use it. */
  ask?: ((question: string) => Promise<string>) | null;
  /** Put the directory `uv` installs `pidgen-worker` into on PATH (default true). */
  onPath?: boolean;
  respond?: () => Response;
  install?: Omit<InstallContextOptions, "env">;
}

/**
 * The worker is missing: the server's release list, PyPI and a fake `uv` answer as for `pidgen
 * worker install`, and `uv tool install` puts the recording stand-in for `pidgen-worker` in its bin
 * directory. The enrollment's install step is a shell command that would leave a marker if run.
 * `events` records every request and every process in the order they happened.
 */
async function missing(options: MissingOptions = {}) {
  const root = await tempDir("pidgen-worker-enroll-missing-");
  const source = join(root, "source-pidgen-worker");
  const record = join(root, "worker-call.json");
  const marker = join(root, "server-command-ran");
  await writeFile(source, WORKER_SCRIPT);
  await chmod(source, 0o755);
  const setup = await installContext({
    ...options.install,
    env: {
      PIDGEN_TOKEN: PAT,
      PIDGEN_ACCOUNT: "ACC-EXAMPLE",
      FAKE_UV_WORKER: source,
      FAKE_WORKER_RECORD: record,
    },
  });
  const { ctx } = setup;
  if (options.onPath !== false) {
    ctx.env["PATH"] = [setup.pathDir, setup.binDir, "/usr/bin", "/bin"].join(delimiter);
  } else {
    // The harness names the installed worker in PIDGEN_WORKER_BIN; off PATH means not that either.
    delete ctx.env["PIDGEN_WORKER_BIN"];
  }
  const serverCommand = `touch '${marker}'`;
  const events: string[] = [];
  const installFetch = ctx.fetch;
  ctx.fetch = (input, init) => {
    const url = String(input);
    events.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${SERVER}/api/v1/workers/enrollments`) {
      return Promise.resolve(options.respond?.() ?? ok(201, enrollment(serverCommand)));
    }
    return installFetch(input, init);
  };
  const runtime = ctx.workerRuntime;
  ctx.workerRuntime = {
    ...runtime,
    spawn: (command, args, spawnOptions) => {
      events.push(`spawn ${[command, ...args].join(" ")}`);
      return runtime.spawn(command, args, spawnOptions);
    },
  };
  const questions: string[] = [];
  ctx.prompter = trapPrompter(options.ask, questions);
  return {
    ...setup,
    events,
    questions,
    serverCommand,
    serverCommandRan: () => exists(marker),
    enrollments: () => events.filter((event) => event.endsWith("/api/v1/workers/enrollments")),
    workerCall: async (): Promise<WorkerCall | null> =>
      (await exists(record)) ? (JSON.parse(await readFile(record, "utf8")) as WorkerCall) : null,
  };
}

const index = (events: string[], pattern: RegExp) =>
  events.findIndex((event) => pattern.test(event));

describe("pidgen worker enroll with the worker missing", () => {
  // AC-aec110ecd558: the shared install runs first, with the same verification, and only then is
  // the enrollment created.
  it("--install runs the verified install of pidgen worker install, then creates the enrollment", async () => {
    const setup = await missing({
      ask: () => Promise.reject(new Error("--install must not ask")),
    });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Ok);
    expect(setup.questions).toEqual([]);
    const { events } = setup;
    const releases = index(events, new RegExp(`^GET ${RELEASES_URL}$`));
    const provenance = index(events, /\/integrity\/pidgen-worker\/1\.0\.0\//);
    const wheel = index(events, new RegExp(`^GET https://files\\.pythonhosted\\.org/.*${WHEEL}$`));
    const install = index(events, / tool install /);
    const enroll = index(events, /^POST .*\/api\/v1\/workers\/enrollments$/);
    const handOver = index(events, /pidgen-worker enroll --token /);
    expect([releases, provenance, wheel, install, enroll, handOver].every((at) => at >= 0)).toBe(
      true,
    );
    expect(releases).toBeLessThan(provenance);
    expect(provenance).toBeLessThan(wheel);
    expect(wheel).toBeLessThan(install);
    expect(install).toBeLessThan(enroll);
    expect(enroll).toBeLessThan(handOver);
    expect(setup.enrollments()).toHaveLength(1);

    // uv was given the very file that was verified, as for `pidgen worker install`.
    const uvInstall = (await setup.uvRuns()).find((entry) => entry.args[1] === "install");
    expect(uvInstall?.sha256).toBe(WHEEL_SHA256);
    expect((await setup.workerCall())?.args).toEqual([
      "enroll",
      "--token",
      ENROLL_TOKEN,
      "--server",
      SERVER,
      "--no-start",
    ]);
    expect(body.data).toMatchObject({
      enrolled: true,
      worker: join(setup.binDir, "pidgen-worker"),
      installed: {
        form: "wheel",
        version: "1.0.0",
        artifact: "pidgen-worker==1.0.0",
        digest: `sha256:${WHEEL_SHA256}`,
        location: join(setup.binDir, "pidgen-worker"),
      },
      enrollment: { enrollment_id: "enr-example-1" },
    });
    // The install record `pidgen worker verify` reads was written.
    const written = JSON.parse(
      await readFile(join(setup.pidgenHome, "run", "pidgen-install.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written).toMatchObject({ version: "1.0.0", digest: `sha256:${WHEEL_SHA256}` });
  });

  it("prints the same licence notice and commands as pidgen worker install", async () => {
    const enroll = await missing();
    expect((await run(enroll.ctx, "worker", "enroll", "--install")).code).toBe(ExitCode.Ok);
    const install = await installContext();
    expect(await runCli(["worker", "install"], install.ctx)).toBe(ExitCode.Ok);

    const printed = (err: string[], root: string) =>
      err
        .join("")
        .split(root)
        .join("<root>")
        .replace(/\.staging-[0-9a-f]+/g, "<staging>");
    const installPrinted = printed(install.ctx.err, install.directory);
    expect(installPrinted).toContain(
      "$ <root>/path/uv tool install --python 3.12 --python-preference only-managed <root>/.pidgen/worker/",
    );
    expect(printed(enroll.ctx.err, enroll.directory)).toContain(installPrinted);
  });

  // The install confirmation moved into `pidgen setup`, the CLI's one interactive command.
  it("never asks, even on a terminal: without --install or --no-install it exits 2, names pidgen setup and spends no enrollment", async () => {
    const setup = await missing({ ask: () => Promise.resolve("y") });

    const { code, body } = await run(setup.ctx, "worker", "enroll");

    expect(code).toBe(ExitCode.Usage);
    expect(setup.questions).toEqual([]);
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "INSTALL_CONFIRMATION_REQUIRED",
        details: { install: { command: "pidgen worker install" }, release: { version: "1.0.0" } },
      },
    });
    expect(body.error?.message).toContain("pidgen setup");
    expect(body.error?.message).toContain("--install");
    expect(setup.enrollments()).toEqual([]);
    expect(await setup.uvRuns()).toEqual([]);
    expect(await setup.workerCall()).toBeNull();
  });

  it("without a terminal and without --install or --no-install asks nothing, exits 2 and spends no enrollment", async () => {
    const setup = await missing({ ask: null });

    const { code, body } = await run(setup.ctx, "worker", "enroll");

    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "INSTALL_CONFIRMATION_REQUIRED",
        details: { install: { command: "pidgen worker install" } },
      },
    });
    expect(setup.enrollments()).toEqual([]);
    expect(await setup.uvRuns()).toEqual([]);
  });

  it("--no-install exits 2 with WORKER_NOT_FOUND, asks nothing and makes no request", async () => {
    const setup = await missing({
      ask: () => Promise.reject(new Error("--no-install must not ask")),
    });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Usage);
    expect(setup.questions).toEqual([]);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "WORKER_NOT_FOUND",
        details: { install: { command: "pidgen worker install" } },
      },
    });
    expect(setup.events).toEqual([]);
  });

  it("a wheel that fails verification exits 5 with PROVENANCE_INVALID and spends no enrollment", async () => {
    const setup = await missing({
      install: { provenance: fixture("provenance-wrong-identity.json") },
    });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "PROVENANCE_INVALID", details: { check: "identity" } },
    });
    expect(setup.enrollments()).toEqual([]);
    expect(await setup.uvRuns()).toEqual([]);
    expect(await setup.workerCall()).toBeNull();
  });

  it("a failing uv install exits 1 with INSTALL_FAILED and spends no enrollment", async () => {
    const setup = await missing({ install: { uvFails: true } });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Unexpected);
    expect(body).toMatchObject({ ok: false, error: { code: "INSTALL_FAILED" } });
    expect(setup.enrollments()).toEqual([]);
  });

  it("without uv exits 2 with RUNTIME_UNAVAILABLE and spends no enrollment", async () => {
    const setup = await missing({ install: { uv: false } });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Usage);
    expect(body).toMatchObject({ ok: false, error: { code: "RUNTIME_UNAVAILABLE" } });
    expect(setup.enrollments()).toEqual([]);
  });

  // home-lookup: the installed worker is run by the path its install record names, off PATH.
  it("an install that leaves pidgen-worker off PATH enrolls with the worker its install record names", async () => {
    const setup = await missing({ onPath: false });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Ok);
    expect(body.data).toMatchObject({
      enrolled: true,
      worker: setup.workerBin,
      installed: { location: setup.workerBin },
    });
    expect(setup.events).toContainEqual(
      expect.stringMatching(new RegExp(`^spawn ${setup.workerBin} enroll `)),
    );
    expect(setup.enrollments()).toHaveLength(1);
  });

  it("a caller who may not enroll workers exits 3 after the install, with no worker enrolled", async () => {
    const setup = await missing({
      respond: () => publicError(403, "FORBIDDEN", "You may not enroll workers."),
    });

    const { code, body } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Auth);
    expect(body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await setup.workerCall()).toBeNull();
  });

  it("token: the one-time token and the worker credential never appear in the envelope or the CLI's files", async () => {
    const setup = await missing();

    const { code } = await run(setup.ctx, "worker", "enroll", "--install");

    expect(code).toBe(ExitCode.Ok);
    const credential = join(setup.pidgenHome, "node-credential");
    expect(await readFile(credential, "utf8")).toBe(NODE_TOKEN);
    const printed = setup.ctx.out.join("") + setup.ctx.err.join("");
    expect(printed).not.toContain(ENROLL_TOKEN);
    expect(printed).not.toContain(NODE_TOKEN);
    for (const file of await filesUnder(setup.directory)) {
      if (file === credential || file.endsWith(".whl")) continue;
      expect(await readFile(file, "utf8")).not.toContain(ENROLL_TOKEN);
    }
  });
});

// AC-43e3c755c6a1: no code path runs a command string from a server response through a shell.
describe("pidgen worker enroll never runs a server command through a shell", () => {
  it("runs only uv and pidgen-worker, with argument lists, and never the enrollment's install step", async () => {
    const setup = await missing();

    expect((await run(setup.ctx, "worker", "enroll", "--install")).code).toBe(ExitCode.Ok);

    expect(await setup.serverCommandRan()).toBe(false);
    const spawned = setup.events.filter((event) => event.startsWith("spawn "));
    expect(spawned.length).toBeGreaterThan(0);
    for (const event of spawned) {
      expect(event).toMatch(
        new RegExp(`^spawn (${setup.pathDir}/uv|${setup.binDir}/pidgen-worker) `),
      );
      expect(event).not.toContain(setup.serverCommand);
    }
    for (const spawn of setup.spawns) {
      expect(spawn.command).not.toMatch(/(^|\/)(ba|z|da)?sh$/);
      expect(spawn.options.shell ?? false).toBe(false);
    }
  });

  it("with the worker installed never runs the enrollment's install step", async () => {
    const { ctx, installRan } = await setup({ installed: true });

    expect((await run(ctx, "worker", "enroll", "--install")).code).toBe(ExitCode.Ok);
    expect(await installRan()).toBe(false);
  });

  it("no source file spawns a shell or passes a command string to one", async () => {
    const root = new URL("../../src/", import.meta.url);
    const files = (await readdir(root, { recursive: true }))
      .filter((name) => name.endsWith(".ts") && !name.startsWith("generated"))
      .map((name) => fileURLToPath(new URL(name, root)));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/["'`]\/bin\/(ba|z|da)?sh["'`]/);
      expect(text, file).not.toMatch(/shell:\s*true/);
      // child_process's exec and execSync run their command string through a shell.
      expect(text, file).not.toMatch(/(?<![.\w])(execSync|exec)\s*\(/);
      expect(text, file).not.toMatch(
        /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*"node:child_process"/,
      );
    }
    expect(Object.keys(await import("../../src/core/worker.js"))).not.toContain(
      "runInstallCommand",
    );
  });

  // The one shell the CLI starts: `pidgen setup` offers uv's own installer, `curl … | sh`, after
  // the person consents. It runs as two argument lists, curl's output piped to sh's standard input;
  // no command string reaches a shell, and no other source file names sh as a command.
  it("starts sh only in setup, for uv's installer, fed by curl with no command string", async () => {
    const root = new URL("../../src/", import.meta.url);
    const files = (await readdir(root, { recursive: true }))
      .filter((name) => name.endsWith(".ts") && !name.startsWith("generated"))
      .map((name) => fileURLToPath(new URL(name, root)));
    const spawnsSh = /spawn\(\s*["'`](ba|z|da)?sh["'`]/;
    const naming: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (spawnsSh.test(text)) naming.push(file);
    }
    expect(naming.map((file) => file.slice(fileURLToPath(root).length))).toEqual([
      join("commands", "setup", "setup.ts"),
    ]);
    const setup = await readFile(naming[0]!, "utf8");
    expect(setup).toMatch(/spawn\(\s*"sh",\s*\[\]/);
    expect(setup).toMatch(/spawn\(\s*"curl",\s*\["-LsSf", UV_INSTALLER_URL\]/);
  });
});

// AC-d957ca9a316a: the documentation describes the new order and the exit codes that still hold.
describe("pidgen worker enroll documentation", () => {
  const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

  it("docs/workers.md installs through pidgen worker install before creating the enrollment", async () => {
    const text = await read("docs/workers.md");
    const start = text.indexOf("## Enroll a worker");
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("\n## ", start + 1));
    expect(section).not.toContain("/bin/sh");
    expect(section).toContain("`pidgen worker install`");
    const install = section.indexOf("same install as `pidgen worker install`");
    const create = section.indexOf("creates an enrollment");
    expect(install).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(install);
    expect(section).toContain("spends no enrollment");
    for (const [code, exit] of [
      ["FORBIDDEN", 3],
      ["WORKER_NOT_FOUND", 2],
      ["INSTALL_CONFIRMATION_REQUIRED", 2],
      ["INSTALL_FAILED", 1],
      ["PROVENANCE_INVALID", 5],
      ["RUNTIME_UNAVAILABLE", 2],
      ["ENROLL_FAILED", 1],
    ] as const) {
      expect(section, code).toMatch(new RegExp(`exits ${exit}[^.]*\`${code}\``));
    }
  });

  it("docs/commands.md and docs/output-and-exit-codes.md no longer describe the server's install step", async () => {
    const commands = await read("docs/commands.md");
    expect(commands).toContain("`installed` (the install\nrecord of the worker the CLI installed");
    const output = await read("docs/output-and-exit-codes.md");
    expect(output).not.toContain("INSTALL_UNAVAILABLE");
    expect(output).not.toContain("INSTALL_DECLINED");
    expect(output).not.toContain("worker's install step");
  });
});
