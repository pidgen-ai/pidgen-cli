import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
if (process.env.FAKE_WORKER_STDERR) process.stderr.write(process.env.FAKE_WORKER_STDERR);
process.exit(Number(process.env.FAKE_WORKER_EXIT ?? "0"));
`;

/** What pidgen-worker enroll prints when the server refuses its host id (it then exits 1). */
const HOST_TAKEN_OUTPUT = (hostId: string) =>
  `host id '${hostId}' is already enrolled in this Account (HTTP 409 WORKER_HOST_TAKEN).\n` +
  "Re-run with a different --host-id, or remove the existing worker from the Workers page\n" +
  "first. Two machines must never share a host id.\n";

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
      [
        "POST",
        `${SERVER}/api/v1/workers/enrollments`,
        { install_id: expect.stringMatching(/^[0-9a-f]{32}$/) },
      ],
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
    expect(calls[0]?.body).toEqual({
      label: "build box",
      install_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
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

  // AC-10cd78f84864: the server's host-taken refusal is named, exit 5, with the host id.
  it("host taken: pidgen-worker's 409 WORKER_HOST_TAKEN refusal exits 5 with WORKER_HOST_TAKEN and the host id", async () => {
    const { ctx, calls } = await setup({
      installed: true,
      env: { FAKE_WORKER_EXIT: "1", FAKE_WORKER_STDERR: HOST_TAKEN_OUTPUT("build-box") },
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--", "--host-id", "build-box");

    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "WORKER_HOST_TAKEN",
        details: {
          host_id: "build-box",
          exit_code: 1,
          enrollment: { enrollment_id: "enr-example-1" },
        },
      },
    });
    expect(body.error!.message).toContain("build-box");
    expect(body.error!.message).toContain("--host-id");
    // The enrollment it could not use is withdrawn (AC-b25f2e3c4fcc).
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    // The worker's own lines still reach standard error.
    expect(ctx.err.join("")).toContain("(HTTP 409 WORKER_HOST_TAKEN)");
    expect(ctx.out.join("")).not.toContain(ENROLL_TOKEN);
    expect(ctx.err.join("")).not.toContain(ENROLL_TOKEN);
  });

  it("host taken: the host id comes from pidgen-worker's refusal when no --host-id was given", async () => {
    const { ctx } = await setup({
      installed: true,
      env: { FAKE_WORKER_EXIT: "1", FAKE_WORKER_STDERR: HOST_TAKEN_OUTPUT("my-host") },
    });

    const { code, body } = await run(ctx, "worker", "enroll");

    expect(code).toBe(ExitCode.Refused);
    expect(body.error).toMatchObject({
      code: "WORKER_HOST_TAKEN",
      details: { host_id: "my-host" },
    });
  });

  // AC-912e7fb02a03: the server refuses the name (409 WORKER_NAME_TAKEN): exit 5 with the name and
  // the server's suggestion in the envelope, and pidgen-worker never runs.
  it("name taken: the server's 409 WORKER_NAME_TAKEN exits 5 with display_name and suggested_name", async () => {
    const { ctx, workerCall, calls, questions } = await setup({
      installed: true,
      ask: () => Promise.resolve(""),
      respond: () =>
        jsonResponse(
          409,
          {
            status: "error",
            error: {
              code: "WORKER_NAME_TAKEN",
              message: "A worker named build-box already exists in this Account.",
              details: { display_name: "build-box", suggested_name: "build-box-2" },
              request_id: "req_fake_error",
            },
          },
          { "x-request-id": "req_fake_error" },
        ),
    });

    const { code, body } = await run(
      ctx,
      "worker",
      "enroll",
      "--label",
      "build-box",
      "--",
      "--host-id",
      "build-box",
    );

    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "WORKER_NAME_TAKEN",
        details: {
          status: 409,
          request_id: "req_fake_error",
          display_name: "build-box",
          suggested_name: "build-box-2",
        },
      },
    });
    expect(body.error!.message).toContain(
      "pidgen worker enroll --label build-box-2 -- --host-id build-box-2",
    );
    expect(calls).toHaveLength(1);
    expect(await workerCall()).toBeNull();
    expect(questions).toEqual([]);
  });

  it("another pidgen-worker enroll failure keeps ENROLL_FAILED, exit 1", async () => {
    const { ctx } = await setup({
      installed: true,
      env: {
        FAKE_WORKER_EXIT: "1",
        FAKE_WORKER_STDERR: "enrollment token expired (HTTP 410 ENROLLMENT_EXPIRED).\n",
      },
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--", "--host-id", "build-box");

    expect(code).toBe(ExitCode.Unexpected);
    expect(body.error).toMatchObject({ code: "ENROLL_FAILED", details: { exit_code: 1 } });
    expect(body.error!.details).not.toHaveProperty("host_id");
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

// A worker home whose worker.env holds a credential: pidgen-worker would skip the token exchange
// and start with it, so an enrollment created now would never be used.
describe("pidgen worker enroll with a saved credential", () => {
  const SAVED = "pidgen_node_fake_saved_credential";
  const savedEnv = [
    "PIDGEN_SERVICE_URL=https://pidgen.example.com",
    `PIDGEN_NODE_TOKEN=${SAVED}`,
    "PIDGEN_LOCALITY_DOMAIN=build-box",
    "",
  ].join("\n");

  async function withSaved(options: Setup = {}) {
    const harness = await setup({ installed: true, ...options });
    const pidgenHome = join(harness.home, ".pidgen");
    await mkdir(pidgenHome, { recursive: true });
    await writeFile(join(pidgenHome, "worker.env"), savedEnv, { mode: 0o600 });
    return { ...harness, pidgenHome, envPath: join(pidgenHome, "worker.env") };
  }

  // AC-7780a71763d5: without --replace-credential, refuses before any enrollment is created.
  it("refuses with exit 5 and WORKER_CREDENTIAL_PRESENT, creates no enrollment and leaves worker.env alone", async () => {
    const { ctx, calls, envPath, workerCall } = await withSaved();

    const { code, body } = await run(ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Refused);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: { code: "WORKER_CREDENTIAL_PRESENT", details: { path: envPath } },
    });
    const message = body.error!.message;
    expect(message).toContain(envPath);
    expect(message).toContain("pidgen worker start");
    expect(message).toContain("--replace-credential");
    expect(calls.filter((call) => call.url.pathname.endsWith("/workers/enrollments"))).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readFile(envPath, "utf8")).toBe(savedEnv);
    expect(await workerCall()).toBeNull();
    expect(ctx.out.join("") + ctx.err.join("")).not.toContain(SAVED);
  });

  // AC-7d75f0a8e0e6: --replace-credential moves worker.env aside before the enrollment is created.
  it("--replace-credential moves worker.env aside, mode 0600, before enrolling, and reports data.replaced", async () => {
    const { ctx, calls, envPath, pidgenHome, workerCall } = await withSaved();
    await chmod(envPath, 0o600);
    let presentAtEnroll: boolean | null = null;
    const fetch = ctx.fetch;
    ctx.fetch = async (input, init) => {
      if (String(input).endsWith("/workers/enrollments")) presentAtEnroll = await exists(envPath);
      return fetch(input, init);
    };

    const { code, body } = await run(ctx, "worker", "enroll", "--replace-credential");

    expect(code).toBe(ExitCode.Ok);
    expect(presentAtEnroll).toBe(false);
    expect(calls).toHaveLength(1);
    const replaced = join(pidgenHome, "worker.env.replaced-19700101T000000Z");
    expect(body.data).toMatchObject({ enrolled: true, replaced });
    expect(await exists(envPath)).toBe(false);
    expect(await readFile(replaced, "utf8")).toBe(savedEnv);
    expect((await stat(replaced)).mode & 0o777).toBe(0o600);
    expect((await workerCall())?.args.slice(0, 3)).toEqual(["enroll", "--token", ENROLL_TOKEN]);
    const shown = ctx.out.join("") + ctx.err.join("");
    expect(shown).not.toContain(SAVED);
    expect(JSON.stringify(body)).not.toContain(SAVED);
  });

  it("--replace-credential never overwrites an earlier replaced file", async () => {
    const { ctx, pidgenHome } = await withSaved();
    const earlier = join(pidgenHome, "worker.env.replaced-19700101T000000Z");
    await writeFile(earlier, "earlier\n", { mode: 0o600 });

    const { code, body } = await run(ctx, "worker", "enroll", "--replace-credential");

    expect(code).toBe(ExitCode.Ok);
    expect(await readFile(earlier, "utf8")).toBe("earlier\n");
    const replaced = body.data?.["replaced"] as string;
    expect(replaced).not.toBe(earlier);
    expect(replaced.startsWith(`${earlier}-`)).toBe(true);
    expect(await readFile(replaced, "utf8")).toBe(savedEnv);
  });

  it("--replace-credential puts worker.env back when the server refuses the enrollment", async () => {
    const { ctx, envPath, workerCall } = await withSaved({
      respond: () => publicError(403, "FORBIDDEN", "You may not enroll workers."),
    });

    const { code } = await run(ctx, "worker", "enroll", "--replace-credential");

    // No enrollment was created, so the saved credential stays where the worker reads it.
    expect(code).toBe(ExitCode.Auth);
    expect(await readFile(envPath, "utf8")).toBe(savedEnv);
    const names = await readdir(join(envPath, ".."));
    expect(names.filter((name) => name.startsWith("worker.env.replaced"))).toEqual([]);
    expect(await workerCall()).toBeNull();
  });

  it("--replace-credential with no worker.env behaves as without it", async () => {
    const { ctx, calls, home } = await setup({ installed: true });

    const { code, body } = await run(ctx, "worker", "enroll", "--replace-credential");

    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
    expect(body.data).not.toHaveProperty("replaced");
    expect(await exists(join(home, ".pidgen"))).toBe(true);
    const names = await readdir(join(home, ".pidgen"));
    expect(names.filter((name) => name.startsWith("worker.env.replaced"))).toEqual([]);
  });

  it("a worker.env without PIDGEN_NODE_TOKEN is no credential: enrolls without the flag", async () => {
    const { ctx, calls, home } = await setup({ installed: true });
    await mkdir(join(home, ".pidgen"), { recursive: true });
    await writeFile(join(home, ".pidgen", "worker.env"), "PIDGEN_SERVICE_URL=x\n");

    const { code } = await run(ctx, "worker", "enroll");

    expect(code).toBe(ExitCode.Ok);
    expect(calls).toHaveLength(1);
  });

  // AC-aa421c4f3870: the help describes the flag and the refusal.
  it("the help describes --replace-credential and the refusal", async () => {
    const ctx = await testContext();
    expect(await runCli(["worker", "enroll", "--help"], ctx)).toBe(ExitCode.Ok);
    const help = ctx.out.join("").replace(/\s+/g, " ");
    expect(help).toContain("--replace-credential");
    expect(help).toContain("worker.env");
    expect(help).toContain("WORKER_CREDENTIAL_PRESENT");
  });
});

/** `POST /workers/enrollments` calls, by body. */
function created(calls: readonly Call[]): unknown[] {
  return calls
    .filter((call) => call.method === "POST" && call.url.pathname.endsWith("/workers/enrollments"))
    .map((call) => call.body);
}

/** `DELETE /workers/enrollments/{id}` calls, by path. */
function withdrawn(calls: readonly Call[]): string[] {
  return calls.filter((call) => call.method === "DELETE").map((call) => call.url.pathname);
}

/** The server's refusal of a field it does not know: FastAPI's `extra_forbidden`, HTTP 422. */
function installIdRefused() {
  return jsonResponse(
    422,
    {
      status: "error",
      error: {
        code: "INPUT_INVALID",
        message: "The request failed validation.",
        details: {
          errors: [
            {
              loc: ["body", "install_id"],
              msg: "Extra inputs are not permitted",
              type: "extra_forbidden",
            },
          ],
        },
        request_id: "req_fake_install_id",
      },
    },
    { "x-request-id": "req_fake_install_id" },
  );
}

// AC-111e49710df5: the install id is made once in the worker home, kept, and sent on every
// enrollment the CLI creates.
describe("pidgen worker enroll and this install's id", () => {
  const ID = /^[0-9a-f]{32}$/;

  it("creates $PIDGEN_HOME/install-id once, keeps it across runs and a moved-aside worker.env, and sends it each time", async () => {
    const { ctx, calls, home } = await setup({ installed: true });
    const file = join(home, ".pidgen", "install-id");
    expect(await exists(file)).toBe(false);

    const first = await run(ctx, "worker", "enroll", "--no-install");

    expect(first.code).toBe(ExitCode.Ok);
    const text = await readFile(file, "utf8");
    // One line: 32 lowercase hex characters (16 random bytes).
    expect(text).toMatch(/^[0-9a-f]{32}\n$/);
    const id = text.trim();
    expect(first.body.data).toMatchObject({ install_id: id });

    // A credential saved since, moved aside by --replace-credential: the install id stays.
    await writeFile(
      join(home, ".pidgen", "worker.env"),
      `PIDGEN_SERVICE_URL=${SERVER}\nPIDGEN_NODE_TOKEN=${NODE_TOKEN}\n`,
      { mode: 0o600 },
    );
    const second = await run(ctx, "worker", "enroll", "--no-install", "--replace-credential");

    expect(second.code).toBe(ExitCode.Ok);
    expect(second.body.data?.["replaced"]).toEqual(expect.stringContaining("worker.env.replaced-"));
    expect(await readFile(file, "utf8")).toBe(text);
    expect(created(calls)).toEqual([{ install_id: id }, { install_id: id }]);
    expect(second.body.data).toMatchObject({ install_id: id });
  });

  it("uses an install id pidgen-worker already wrote, and sends it with --label", async () => {
    const { ctx, calls, home } = await setup({ installed: true });
    const id = "0123456789abcdef0123456789abcdef";
    await mkdir(join(home, ".pidgen"), { recursive: true });
    await writeFile(join(home, ".pidgen", "install-id"), `${id}\n`);

    const { code } = await run(ctx, "worker", "enroll", "--label", "build box", "--no-install");

    expect(code).toBe(ExitCode.Ok);
    expect(created(calls)).toEqual([{ label: "build box", install_id: id }]);
    expect(await readFile(join(home, ".pidgen", "install-id"), "utf8")).toBe(`${id}\n`);
  });

  it("an invalid install-id is left alone with a note, and no id is sent", async () => {
    const { ctx, calls, home } = await setup({ installed: true });
    const file = join(home, ".pidgen", "install-id");
    await mkdir(join(home, ".pidgen"), { recursive: true });
    await writeFile(file, "NOT-AN-ID\n");

    const { code, body } = await run(ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Ok);
    expect(await readFile(file, "utf8")).toBe("NOT-AN-ID\n");
    expect(created(calls)).toEqual([{}]);
    expect(body.data).toMatchObject({ install_id: null });
    expect(ctx.err.join("")).toContain(`${file} is not an install id`);
  });

  it("the install id is never derived from the machine: two homes get different ids", async () => {
    const a = await setup({ installed: true });
    const b = await setup({ installed: true });
    await run(a.ctx, "worker", "enroll", "--no-install");
    await run(b.ctx, "worker", "enroll", "--no-install");
    const [first] = created(a.calls) as Array<{ install_id: string }>;
    const [second] = created(b.calls) as Array<{ install_id: string }>;
    expect(first!.install_id).toMatch(ID);
    expect(second!.install_id).toMatch(ID);
    expect(first!.install_id).not.toBe(second!.install_id);
  });

  // AC-351ddea6a356: a server from before install ids refuses the field; one retry without it.
  it("a 422 naming install_id is retried once without the field, and the enrollment goes ahead", async () => {
    let posts = 0;
    const { ctx, calls, home } = await setup({
      installed: true,
      respond: (call) => {
        if (call.method !== "POST") return ok(200, {});
        posts++;
        return posts === 1 ? installIdRefused() : ok(201, enrollment("true"));
      },
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--no-install");

    expect(body.error).toBeNull();
    expect(code).toBe(ExitCode.Ok);
    const id = (await readFile(join(home, ".pidgen", "install-id"), "utf8")).trim();
    expect(created(calls)).toEqual([{ install_id: id }, {}]);
    expect(body.data).toMatchObject({ enrolled: true, install_id: null });
  });

  it("a 422 that does not name install_id is not retried", async () => {
    const { ctx, calls } = await setup({
      installed: true,
      respond: () => publicError(422, "INPUT_INVALID", "label: too long"),
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Usage);
    expect(body.error).toMatchObject({ code: "INPUT_INVALID" });
    expect(created(calls)).toHaveLength(1);
  });
});

// AC-b25f2e3c4fcc: an enrollment the command created and could not use is withdrawn before it
// exits, and the original failure is reported with its exit code.
describe("pidgen worker enroll withdraws an enrollment it cannot use", () => {
  const WITHDRAW = "/api/v1/workers/enrollments/enr-example-1";

  it("a failing pidgen-worker enroll: DELETE the enrollment, then ENROLL_FAILED, exit 1, saying so", async () => {
    const { ctx, calls } = await setup({ installed: true, env: { FAKE_WORKER_EXIT: "9" } });

    const { code, body } = await run(ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Unexpected);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /api/v1/workers/enrollments",
      `DELETE ${WITHDRAW}`,
    ]);
    expect(body).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: "ENROLL_FAILED",
        details: {
          exit_code: 9,
          withdrawn: true,
          enrollment: { enrollment_id: "enr-example-1" },
        },
      },
    });
    expect(body.error!.message).toContain("pidgen-worker enroll exited with status 9.");
    expect(body.error!.message).toContain("The enrollment enr-example-1 was withdrawn.");
    expect(ctx.out.join("") + ctx.err.join("")).not.toContain(ENROLL_TOKEN);
  });

  it("a host-taken refusal withdraws the enrollment too, keeping WORKER_HOST_TAKEN, exit 5", async () => {
    const { ctx, calls } = await setup({
      installed: true,
      env: { FAKE_WORKER_EXIT: "1", FAKE_WORKER_STDERR: HOST_TAKEN_OUTPUT("build-box") },
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--", "--host-id", "build-box");

    expect(code).toBe(ExitCode.Refused);
    expect(withdrawn(calls)).toEqual([WITHDRAW]);
    expect(body.error).toMatchObject({
      code: "WORKER_HOST_TAKEN",
      details: { host_id: "build-box", withdrawn: true },
    });
  });

  it("a failed withdraw is a note: the original failure and its exit code stand", async () => {
    const { ctx, calls } = await setup({
      installed: true,
      env: { FAKE_WORKER_EXIT: "9" },
      respond: (call) =>
        call.method === "DELETE"
          ? publicError(500, "INTERNAL_ERROR", "Something went wrong.")
          : ok(201, enrollment("true")),
    });

    const { code, body } = await run(ctx, "worker", "enroll", "--no-install");

    expect(code).toBe(ExitCode.Unexpected);
    expect(withdrawn(calls)).toEqual([WITHDRAW]);
    expect(body.error).toMatchObject({
      code: "ENROLL_FAILED",
      details: {
        exit_code: 9,
        withdrawn: false,
        withdraw_error: { code: "INTERNAL_ERROR" },
      },
    });
    expect(body.error!.message).toContain("could not be withdrawn");
    expect(ctx.err.join("")).toContain("Could not withdraw the enrollment enr-example-1");
  });

  it("a successful enrollment is not withdrawn, and a refused one has nothing to withdraw", async () => {
    const good = await setup({ installed: true });
    expect((await run(good.ctx, "worker", "enroll", "--no-install")).code).toBe(ExitCode.Ok);
    expect(withdrawn(good.calls)).toEqual([]);

    const refused = await setup({
      installed: true,
      respond: () => publicError(403, "FORBIDDEN", "You may not enroll workers."),
    });
    expect((await run(refused.ctx, "worker", "enroll", "--no-install")).code).toBe(ExitCode.Auth);
    expect(withdrawn(refused.calls)).toEqual([]);
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
      ["WORKER_CREDENTIAL_PRESENT", 5],
    ] as const) {
      expect(section, code).toMatch(new RegExp(`exits ${exit}[^.]*\`${code}\``));
    }
  });

  // AC-aa421c4f3870: the command reference and the changelog describe the flag and the refusal.
  it("docs/commands.md, the changelog and the exit-code table describe --replace-credential and the refusal", async () => {
    const commands = await read("docs/commands.md");
    expect(commands).toContain("[--replace-credential]");
    expect(commands).toMatch(/exit 5, `WORKER_CREDENTIAL_PRESENT`/);
    expect(commands).toContain("`data.replaced`");
    const changelog = await read("CHANGELOG.md");
    // These changes shipped in 0.1.0-alpha.4: its section and anything newer.
    const alpha4 = changelog.slice(0, changelog.indexOf("\n## 0.1.0-alpha.3"));
    expect(alpha4).toContain("--replace-credential");
    expect(alpha4).toContain("WORKER_CREDENTIAL_PRESENT");
    expect(await read("docs/output-and-exit-codes.md")).toContain("`WORKER_CREDENTIAL_PRESENT`");
    // AC-6f5cec81c80b: the test bed's removed-worker path is recorded as a manual check.
    const troubleshooting = await read("docs/troubleshooting.md");
    const section = troubleshooting.slice(
      troubleshooting.indexOf("### Re-enroll a removed worker"),
    );
    expect(section).toContain("Manual check (test bed)");
    expect(section).toContain("remove the worker on the Workers page");
  });

  // AC-a39e0f7431c6: the host-taken refusal and setup's recovery are documented.
  it("docs, the changelog and the exit-code table describe WORKER_HOST_TAKEN and setup's recovery", async () => {
    const troubleshooting = await read("docs/troubleshooting.md");
    expect(troubleshooting).toContain("`WORKER_HOST_TAKEN`");
    expect(troubleshooting).toContain("is taken in Pidgen, so this worker needs another name.");
    const changelog = await read("CHANGELOG.md");
    // These changes shipped in 0.1.0-alpha.4: its section and anything newer.
    const alpha4 = changelog.slice(0, changelog.indexOf("\n## 0.1.0-alpha.3"));
    expect(alpha4).toContain("WORKER_HOST_TAKEN");
    const commands = await read("docs/commands.md");
    expect(commands).toMatch(/exit 5, `WORKER_HOST_TAKEN`/);
    expect(commands).toContain("`error.details.host_id`");
    const install = await read("docs/install-worker.md");
    expect(install).toContain("WORKER_HOST_TAKEN");
    expect(install).toContain("pidgen setup --label");
    expect(await read("docs/output-and-exit-codes.md")).toContain("`WORKER_HOST_TAKEN`");
    const skill = await read("skills/pidgen-setup-worker/SKILL.md");
    expect(skill).toContain("`WORKER_HOST_TAKEN`");
    expect(skill).not.toContain("remove the old worker in the web app");
  });

  // AC-64620a5703ee: the name question and WORKER_NAME_TAKEN are documented.
  it("docs and the changelog describe setup's name question and WORKER_NAME_TAKEN", async () => {
    const install = await read("docs/install-worker.md");
    expect(install).toContain("`Worker name`");
    expect(install).toContain("WORKER_NAME_TAKEN");
    expect(install).toContain("suggested_name");
    const commands = await read("docs/commands.md");
    expect(commands).toMatch(/exit 5, `WORKER_NAME_TAKEN`/);
    expect(commands).toContain("`Worker name`");
    expect(commands).toContain("`error.details.suggested_name`");
    expect(commands).not.toContain("a `--label` the Account already lists stops with `CLI_USAGE`");
    expect(await read("docs/output-and-exit-codes.md")).toContain("`WORKER_NAME_TAKEN`");
    const troubleshooting = await read("docs/troubleshooting.md");
    expect(troubleshooting).toContain("`WORKER_NAME_TAKEN`");
    expect(troubleshooting).not.toContain("Setup asks `Name for this worker`");
    const changelog = await read("CHANGELOG.md");
    // These changes shipped in 0.1.0-alpha.4: its section and anything newer.
    const alpha4 = changelog.slice(0, changelog.indexOf("\n## 0.1.0-alpha.3"));
    expect(alpha4).toContain("WORKER_NAME_TAKEN");
    expect(alpha4).toContain("`Worker name`");
  });

  // The install id is named under what the CLI sends; the withdraw and the replace question are
  // documented with the changelog (AC-111e49710df5, AC-b25f2e3c4fcc, AC-d5cd762a88e7).
  it("docs and the changelog describe the install id, the replace question and the withdrawn enrollment", async () => {
    const install = await read("docs/install-worker.md");
    const sends = install.slice(install.indexOf("### What setup keeps and sends"));
    expect(sends).toContain("`install-id`");
    expect(sends).toContain("`install_id`");
    expect(install).toContain("is still listed but its credential is missing.");
    expect(install).toContain("`Replace my-host?`");
    const workers = await read("docs/workers.md");
    expect(workers).toContain("### This install's id");
    expect(workers).toContain("DELETE /api/v1/workers/enrollments/{enrollment_id}");
    expect(workers).not.toContain("could not hand to a worker is\nnot used and expires on its own");
    const troubleshooting = await read("docs/troubleshooting.md");
    expect(troubleshooting).toContain("`error.details.withdrawn`");
    expect(troubleshooting).toContain("is still listed but its credential is missing.");
    const commands = await read("docs/commands.md");
    expect(commands).toContain("`install_id` (this install's id");
    expect(commands).toContain("`error.details.withdrawn` is `true`");
    const changelog = await read("CHANGELOG.md");
    // These changes shipped in 0.1.0-alpha.4: its section and anything newer.
    const alpha4 = changelog.slice(0, changelog.indexOf("\n## 0.1.0-alpha.3"));
    expect(alpha4).toContain("install-id");
    expect(alpha4).toContain("contracts/pending/worker-enrollments.json");
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
